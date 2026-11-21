/**
 * Gemini como auditor externo — opcional, com cota controlada.
 *
 * Regras que este arquivo implementa:
 *  - o produto funciona 100% sem Gemini: sem chave, devolve "não configurado";
 *  - cota diária local (padrão 3) mais consultas extraordinárias pedidas pelo
 *    proprietário; a contagem fica no banco, não em memória;
 *  - nunca cobrança automática: se a cota acabou, recusa e explica;
 *  - o Gemini NÃO captura dado nem altera o banco: só devolve texto de revisão.
 */
import type { LocalDatabase } from "../database/db.js";

export const DEFAULT_DAILY_QUOTA = 3;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiConfig {
  apiKey: string | null;
  model: string;
  dailyQuota: number;
}

export interface GeminiResult {
  ok: boolean;
  text: string | null;
  /** Por que não houve resposta — nunca mascarado. */
  reason: "OK" | "NOT_CONFIGURED" | "QUOTA_EXCEEDED" | "NETWORK" | "API_ERROR";
  detail?: string;
  quotaRemaining: number;
}

/** Lê a configuração do ambiente. Sem chave, o serviço segue sem Gemini. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiConfig {
  const quota = Number(env.LMA_GEMINI_DAILY_QUOTA ?? DEFAULT_DAILY_QUOTA);
  return {
    apiKey: env.LMA_GEMINI_API_KEY?.trim() || null,
    model: env.LMA_GEMINI_MODEL?.trim() || "gemini-2.0-flash",
    dailyQuota: Number.isFinite(quota) && quota >= 0 ? quota : DEFAULT_DAILY_QUOTA,
  };
}

export class GeminiAuditor {
  constructor(
    private readonly db: LocalDatabase,
    private readonly config: GeminiConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private usedToday(): number {
    const row = this.db
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM gemini_calls WHERE day = ?")
      .get(this.today()) as { n: number };
    return row.n;
  }

  /** Sem chave o produto continua funcionando; a auditoria externa é que fica off. */
  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  quotaRemaining(): number {
    return Math.max(0, this.config.dailyQuota - this.usedToday());
  }

  /** Registra a chamada ANTES de sair para a rede: cota não se perde por falha. */
  private consume(prompt: string, kind: string): void {
    this.db
      .raw()
      .prepare("INSERT INTO gemini_calls (day, at, kind, prompt_chars) VALUES (?, ?, ?, ?)")
      .run(this.today(), this.now().toISOString(), kind, prompt.length);
  }

  /** Consulta extraordinária: só o proprietário pode autorizar (checado no serviço). */
  grantExtra(quantity = 1): void {
    this.db
      .raw()
      .prepare("INSERT INTO gemini_grants (day, at, quantity) VALUES (?, ?, ?)")
      .run(this.today(), this.now().toISOString(), quantity);
  }

  extraGrantedToday(): number {
    const row = this.db
      .raw()
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM gemini_grants WHERE day = ?")
      .get(this.today()) as { n: number };
    return row.n;
  }

  private effectiveQuota(): number {
    return this.config.dailyQuota + this.extraGrantedToday();
  }

  async ask(prompt: string, kind = "audit"): Promise<GeminiResult> {
    if (!this.config.apiKey) {
      return {
        ok: false,
        text: null,
        reason: "NOT_CONFIGURED",
        detail: "Nenhuma chave do Gemini configurada. O produto funciona sem ele.",
        quotaRemaining: 0,
      };
    }
    const remaining = Math.max(0, this.effectiveQuota() - this.usedToday());
    if (remaining <= 0) {
      return {
        ok: false,
        text: null,
        reason: "QUOTA_EXCEEDED",
        detail: `Cota diária de ${this.effectiveQuota()} consultas atingida. Nada é cobrado automaticamente.`,
        quotaRemaining: 0,
      };
    }

    this.consume(prompt, kind);

    try {
      const response = await fetch(
        `${ENDPOINT}/${this.config.model}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          text: null,
          reason: "API_ERROR",
          detail: `HTTP ${response.status}: ${body.slice(0, 300)}`,
          quotaRemaining: remaining - 1,
        };
      }
      const json = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? null;
      return {
        ok: Boolean(text),
        text,
        reason: text ? "OK" : "API_ERROR",
        detail: text ? undefined : "resposta sem texto",
        quotaRemaining: remaining - 1,
      };
    } catch (err) {
      return {
        ok: false,
        text: null,
        reason: "NETWORK",
        detail: String(err),
        quotaRemaining: remaining - 1,
      };
    }
  }
}
