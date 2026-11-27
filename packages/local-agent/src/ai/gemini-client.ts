/**
 * Cliente da API Gemini (camada multi-provedor com Gemini como provedor prioritário, §18).
 * Regras: orçamento por agente, registro de consumo, pausa quando a cota acaba,
 * e NUNCA simular resposta de IA quando a chamada falha (§29.1).
 */
import type { LocalDatabase } from '../db/database';
import type { SecretStore } from '../security/secrets';

export const GEMINI_MODELS = {
  fast: 'gemini-2.5-flash',
  balanced: 'gemini-2.5-pro',
  cheap: 'gemini-2.5-flash-lite',
} as const;
export type GeminiModel = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];

export interface GeminiBudget {
  /** Máximo de tokens de entrada por chamada. */
  maxInputTokens: number;
  /** Máximo de tokens de saída por chamada. */
  maxOutputTokens: number;
  /** Custo máximo acumulado (USD) por dia, por conta. */
  dailyCostLimitUsd: number;
}

export const DEFAULT_BUDGET: GeminiBudget = {
  maxInputTokens: 60_000,
  maxOutputTokens: 4_096,
  dailyCostLimitUsd: 3,
};

/** Preços de referência (USD por 1M tokens). Podem ser sobrescritos em settings. */
export const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

export interface GeminiCallInput {
  agentKey: string;
  model: GeminiModel;
  systemPrompt: string;
  userContent: string;
  accountId?: string;
  temperature?: number;
  budget?: Partial<GeminiBudget>;
  /** Injeção de transporte para testes. */
  transport?: GeminiTransport;
}

export type GeminiTransport = (req: {
  model: string;
  apiKey: string;
  body: unknown;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json: unknown }>;

export type GeminiCallResult =
  | {
      ok: true;
      text: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      model: string;
      latencyMs: number;
    }
  | {
      ok: false;
      errorCode: 'NO_KEY' | 'BUDGET_EXCEEDED' | 'QUOTA' | 'RATE_LIMIT' | 'HTTP_ERROR' | 'EMPTY_RESPONSE' | 'NETWORK';
      message: string;
      /** true quando a causa é limite/cota: o sistema deve pausar chamadas externas. */
      pauseExternal: boolean;
    };

export const GEMINI_KEY_NAME = 'gemini.apiKey';

/** Transporte HTTP real (fetch nativo). Isolado para permitir testes determinísticos. */
export const httpTransport: GeminiTransport = async ({ model, apiKey, body, signal }) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
};

function estimateTokens(text: string): number {
  // Heurística conservadora: ~4 caracteres por token.
  return Math.ceil(text.length / 4);
}

export class GeminiClient {
  private busy=false;
  private pausedUntil=0;
  constructor(
    private readonly db: LocalDatabase,
    private readonly secrets: SecretStore,
    private readonly transport: GeminiTransport = httpTransport,
  ) {}

  setKey(key: string): void {
    this.secrets.set(GEMINI_KEY_NAME, key);
    this.pausedUntil=0;
  }

  clearKey(): void {
    if(this.busy)throw Error('aguarde o término da chamada Gemini em andamento');
    this.secrets.delete(GEMINI_KEY_NAME);this.pausedUntil=0;
  }

  hasKey(): boolean {
    return this.secrets.has(GEMINI_KEY_NAME);
  }

  keyHint(): string | null {
    return this.secrets.hint(GEMINI_KEY_NAME);
  }

  spentTodayUsd(accountId?: string): number {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const row = accountId
      ? (this.db.db
          .prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM gemini_usage WHERE at >= ? AND account_id = ?')
          .get(since, accountId) as { s: number })
      : (this.db.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM gemini_usage WHERE at >= ?').get(since) as {
          s: number;
        });
    return row.s;
  }

  /** Chamada com orçamento, registro de consumo e tratamento honesto de falhas. */
  async call(input: GeminiCallInput): Promise<GeminiCallResult> {
    if(this.busy)return {ok:false,errorCode:'RATE_LIMIT',message:'Já existe chamada externa em andamento; aguarde sua conclusão.',pauseExternal:false};
    if(Date.now()<this.pausedUntil)return {ok:false,errorCode:'RATE_LIMIT',message:'Chamadas externas temporariamente pausadas após limite do provedor.',pauseExternal:true};
    this.busy=true;
    try{return await this.callOnce(input);}finally{this.busy=false;}
  }

  private async callOnce(input:GeminiCallInput):Promise<GeminiCallResult>{
    const started = Date.now();
    const budget = { ...DEFAULT_BUDGET, ...input.budget };

    const apiKey = this.secrets.get(GEMINI_KEY_NAME);
    if (!apiKey) {
      return {
        ok: false,
        errorCode: 'NO_KEY',
        message: 'chave da API Gemini não configurada pelo super_admin; funções locais continuam disponíveis',
        pauseExternal: true,
      };
    }

    const estimatedIn = estimateTokens(input.systemPrompt + input.userContent);
    if (estimatedIn > budget.maxInputTokens) {
      return {
        ok: false,
        errorCode: 'BUDGET_EXCEEDED',
        message: `prompt estimado em ${estimatedIn} tokens excede o limite de ${budget.maxInputTokens}`,
        pauseExternal: false,
      };
    }

    const price = PRICE_TABLE[input.model] ?? PRICE_TABLE['gemini-2.5-flash']!;
    const estimatedCost =
      (estimatedIn / 1_000_000) * price.input + (budget.maxOutputTokens / 1_000_000) * price.output;
    if (!Number.isFinite(budget.dailyCostLimitUsd)||budget.dailyCostLimitUsd<=0||this.spentTodayUsd() + estimatedCost > budget.dailyCostLimitUsd||this.spentTodayUsd(input.accountId)+estimatedCost>budget.dailyCostLimitUsd) {
      return {
        ok: false,
        errorCode: 'BUDGET_EXCEEDED',
        message: `limite diário de US$ ${budget.dailyCostLimitUsd} atingido; chamadas externas pausadas`,
        pauseExternal: true,
      };
    }

    const body = {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: input.userContent }] }],
      generationConfig: {
        temperature: input.temperature ?? 0.3,
        maxOutputTokens: budget.maxOutputTokens,
      },
    };

    let res: { ok: boolean; status: number; json: unknown };
    try {
      res = await this.transport({ model: input.model, apiKey, body });
    } catch (err) {
      return {
        ok: false,
        errorCode: 'NETWORK',
        message: 'Falha de rede ao chamar o Gemini; custo real não confirmado.',
        pauseExternal: false,
      };
    }

    const record = (tokensIn: number, tokensOut: number, cost: number, status: string, error?: string) => {
      this.db.db
        .prepare(
          `INSERT INTO gemini_usage (account_id, at, agent_key, model, tokens_in, tokens_out, cost_usd, status, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.accountId ?? null, new Date().toISOString(), input.agentKey, input.model, tokensIn, tokensOut, cost, status, error ?? null);
    };

    if (!res.ok) {
      const status = res.status;
      if(status===429)this.pausedUntil=Date.now()+15*60_000;
      if(status===401||status===403)this.pausedUntil=Date.now()+5*60_000;
      const errorCode: 'RATE_LIMIT' | 'NO_KEY' | 'HTTP_ERROR' =
        status === 429 ? 'RATE_LIMIT' : status === 403 || status === 401 ? 'NO_KEY' : 'HTTP_ERROR';
      record(estimatedIn, 0, (estimatedIn / 1_000_000) * price.input, 'ERROR', `HTTP ${status}`);
      return {
        ok: false,
        errorCode,
        message:
          status === 429
            ? 'limite de requisições do Gemini atingido; chamadas externas pausadas até a cota renovar'
            : status === 403 || status === 401
              ? 'chave da API Gemini inválida ou sem permissão'
              : `erro HTTP ${status} na API Gemini`,
        pauseExternal: status === 429 || status === 403 || status === 401,
      };
    }

    const parsed = res.json as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    } | null;

    const text = parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) {
      record(estimatedIn, 0, (estimatedIn / 1_000_000) * price.input, 'EMPTY');
      return { ok: false, errorCode: 'EMPTY_RESPONSE', message: 'Gemini devolveu resposta vazia', pauseExternal: false };
    }

    const validTokens=(v:unknown,fallback:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:fallback;
    const tokensIn = validTokens(parsed?.usageMetadata?.promptTokenCount,estimatedIn);
    const tokensOut = validTokens(parsed?.usageMetadata?.candidatesTokenCount,estimateTokens(text));
    const cost = (tokensIn / 1_000_000) * price.input + (tokensOut / 1_000_000) * price.output;
    record(tokensIn, tokensOut, cost, 'OK');

    return {
      ok: true,
      text,
      tokensIn,
      tokensOut,
      costUsd: Math.round(cost * 1e6) / 1e6,
      model: input.model,
      latencyMs: Date.now() - started,
    };
  }

  /** Teste explícito de chave: devolve o resultado real, sem mascarar falha. */
  async testKey(): Promise<GeminiCallResult> {
    return this.call({
      agentKey: 'system.key_test',
      model: GEMINI_MODELS.cheap,
      systemPrompt: 'Responda apenas OK.',
      userContent: 'ping',
      budget: { maxOutputTokens: 8 },
    });
  }
}

/** Decisão de uso do Gemini vs. geração local (§13.2: redução progressiva de chamadas). */
export interface LearningCoverage {
  category: string;
  marketplace: string;
  patternValidations: number;
  patternSuccessRate: number;
  lastValidatedAt: string | null;
}

export function shouldCallGemini(params: {
  coverage: LearningCoverage | null;
  executionIndex: number;
  validationEveryN: number;
  hasDivergence: boolean;
  isNewCategory: boolean;
}): { call: boolean; reason: string } {
  if (params.isNewCategory) return { call: true, reason: 'categoria inédita: sem base local validada' };
  if (params.hasDivergence) return { call: true, reason: 'divergência detectada na validação local' };
  if (!params.coverage) return { call: true, reason: 'nenhum padrão local aprendido para este contexto' };
  if (params.coverage.patternValidations < 3) {
    return { call: true, reason: `apenas ${params.coverage.patternValidations} validações locais (mínimo 3)` };
  }
  if (params.coverage.patternSuccessRate < 0.9) {
    return { call: true, reason: `taxa de sucesso local ${(params.coverage.patternSuccessRate * 100).toFixed(0)}% abaixo de 90%` };
  }
  if (params.executionIndex % Math.max(1, params.validationEveryN) === 0) {
    return { call: true, reason: `auditoria amostral periódica (a cada ${params.validationEveryN} execuções)` };
  }
  return { call: false, reason: 'padrão local consolidado: geração sem consulta externa' };
}
