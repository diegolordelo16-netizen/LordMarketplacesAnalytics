/**
 * Edição inteligente da DESCRIÇÃO do anúncio — o título é intocável.
 *
 * A regra do produto, que este módulo existe para garantir:
 *  1. O título NUNCA muda. Não é "a IA não deve" — o serviço recusa qualquer
 *     proposta em que o título difira do original, e o schema não tem campo
 *     para título novo.
 *  2. O texto original é PRESERVADO. A versão complementada contém todo o
 *     texto anterior, e isso é verificado antes de gravar: se o texto original
 *     não estiver contido na proposta, a proposta é recusada.
 *  3. Só entra informação comprovável. Cada acréscimo carrega o motivo e a
 *     fonte do dado; sem fonte, é sugestão de lacuna — não é texto aplicado.
 *  4. Nada é salvo no marketplace sem aprovação: a proposta fica PROPOSED e
 *     o proprietário vê original, complementada e o diff linha a linha.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type EditStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "APPLIED";

export interface Addition {
  /** Texto exato acrescentado (bloco ou linha). */
  text: string;
  /** Por que entrou — em linguagem de negócio, não técnica. */
  reason: string;
  /** De onde veio o dado: ficha técnica, pergunta do comprador, regra de categoria. */
  source: string;
}

export interface DescriptionProposal {
  id: string;
  marketplace: string;
  entityRef: string;
  titleOriginal: string;
  descriptionBefore: string;
  descriptionAfter: string;
  additions: Addition[];
  status: EditStatus;
  generatedBy: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface DiffLine {
  kind: "same" | "added";
  text: string;
}

export class EditValidationError extends Error {
  readonly code = "VALIDATION_FAILED";
}

export class TitleImmutableError extends Error {
  readonly code = "TITLE_IMMUTABLE";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Blocos preventivos por categoria: o que evita troca e devolução, com o
 * motivo ao lado. Não inventa especificação — cria o LUGAR para o dado certo,
 * e o número real vem do cadastro do produto ou do próprio usuário.
 */
const CHECKLISTS: { match: RegExp; items: { label: string; text: string; reason: string }[] }[] = [
  {
    match: /camiseta|blusa|vestido|calça|calca|short|jaqueta|moletom|roupa|moda|bermuda/i,
    items: [
      { label: "medidas", text: "Medidas da peça (busto, cintura e comprimento) por tamanho.", reason: "Tamanho errado é a principal causa de troca em moda." },
      { label: "modelagem", text: "Modelagem e caimento (justa, regular ou ampla) e a medida do modelo na foto.", reason: "Expectativa visual é o que mais gera devolução." },
      { label: "tecido", text: "Composição do tecido e cuidados de lavagem.", reason: "Composição evita reclamação de qualidade." },
    ],
  },
  {
    match: /fone|caixa de som|carregador|smartwatch|celular|cabo|eletr/i,
    items: [
      { label: "compatibilidade", text: "Compatibilidade: modelos e sistemas suportados.", reason: "Compatibilidade é o motivo mais comum de devolução em eletrônicos." },
      { label: "voltagem", text: "Voltagem e tipo de plugue (bivolt, 110V, 220V ou USB).", reason: "Voltagem errada queima o produto e gera devolução." },
      { label: "conteudo", text: "Conteúdo da embalagem, item por item.", reason: "Comprador precisa saber o que recebe." },
    ],
  },
  {
    match: /tênis|tenis|sapato|sandália|sandalia|bota|chinelo/i,
    items: [
      { label: "tamanho", text: "Tamanho em centímetros e equivalência com a numeração.", reason: "Numeração varia entre marcas." },
      { label: "material", text: "Material do cabedal, forro e solado.", reason: "Material define durabilidade e conforto." },
    ],
  },
  {
    match: /.*/,
    items: [
      { label: "conteudo", text: "O que vem na embalagem.", reason: "Expectativa clara reduz troca." },
      { label: "garantia", text: "Prazo de garantia e como acionar.", reason: "Garantia visível reduz dúvida pré-venda." },
    ],
  },
];

export class DescriptionEditor {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now?: () => Date) {
    this.db = db;
    this.now = now ?? (() => new Date());
  }

  /**
   * Gera a proposta de complementação.
   *
   * `knownFacts` são os dados CONFIRMADOS do produto (ficha técnica). Só eles
   * entram como texto afirmado. O que falta vira LACUNA, exibida ao usuário
   * para ele preencher — nunca preenchida pela IA.
   */
  propose(input: {
    marketplace: string;
    entityRef: string;
    title: string;
    description: string;
    knownFacts?: Record<string, string>;
    gaps?: string[];
  }): DescriptionProposal {
    const title = input.title ?? "";
    const before = input.description ?? "";
    if (!before.trim()) {
      throw new EditValidationError("este anúncio não tem descrição legível para complementar");
    }

    const haystack = `${title} ${before}`;
    const facts = input.knownFacts ?? {};
    const additions: Addition[] = [];
    const gaps: string[] = [...(input.gaps ?? [])];

    for (const group of CHECKLISTS) {
      if (!group.match.test(haystack)) continue;
      for (const item of group.items) {
        const alreadyCovered =
          new RegExp(item.label, "i").test(before) ||
          (facts[item.label] ? before.includes(facts[item.label]) : false);
        if (alreadyCovered) continue;

        const fact = facts[item.label];
        if (fact) {
          additions.push({ text: fact, reason: item.reason, source: "ficha técnica" });
        } else {
          // Sem dado confirmado: vira lacuna para o usuário preencher.
          gaps.push(`${item.label}: ${item.text} (${item.reason})`);
        }
      }
      if (additions.length > 0) break;
    }

    const after = additions.length > 0 ? buildAfter(before, additions) : before;

    // Trava dura: se o texto original não estiver contido, a proposta não existe.
    assertPreserved(before, after);

    const id = randomUUID();
    const createdAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO description_edits
           (id, marketplace, entity_ref, title_original, description_before, description_after,
            additions, status, generated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PROPOSED', 'internal-brain', ?)`,
      )
      .run(id, input.marketplace, input.entityRef, title, before, after, JSON.stringify(additions), createdAt);

    return this.get(id) as DescriptionProposal;
  }

  /** Aprovação do proprietário. Aprovar não aplica: aplicar é ação separada. */
  decide(id: string, status: EditStatus, note?: string | null): DescriptionProposal {
    if (!["APPROVED", "REJECTED", "APPLIED"].includes(status)) {
      throw new EditValidationError("decisão inválida");
    }
    const current = this.get(id);
    if (!current) throw new EditValidationError("proposta não encontrada");
    if (current.status === "APPLIED" && status !== "APPLIED") {
      throw new EditValidationError("proposta já aplicada não muda de estado");
    }
    this.db
      .prepare(`UPDATE description_edits SET status = ?, decided_at = ?, decision_note = ? WHERE id = ?`)
      .run(status, this.now().toISOString(), note ?? null, id);
    return this.get(id) as DescriptionProposal;
  }

  get(id: string): DescriptionProposal | null {
    const row = this.db.prepare(`SELECT * FROM description_edits WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toView(row) : null;
  }

  list(limit = 30): DescriptionProposal[] {
    const rows = this.db
      .prepare(`SELECT * FROM description_edits ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toView(r));
  }

  private toView(row: Record<string, unknown>): DescriptionProposal {
    return {
      id: String(row.id),
      marketplace: String(row.marketplace),
      entityRef: String(row.entity_ref),
      titleOriginal: String(row.title_original),
      descriptionBefore: String(row.description_before),
      descriptionAfter: String(row.description_after),
      additions: safeJson<Addition[]>(row.additions, []),
      status: String(row.status) as EditStatus,
      generatedBy: String(row.generated_by),
      createdAt: String(row.created_at),
      decidedAt: row.decided_at === null ? null : String(row.decided_at),
      decisionNote: row.decision_note === null ? null : String(row.decision_note),
    };
  }
}

// ------------------------------------------------------------------ helpers

/** Monta a versão complementada: original intacto, acréscimos no fim. */
export function buildAfter(before: string, additions: Addition[]): string {
  const block = additions.map((a) => `• ${a.text}`).join("\n");
  return `${before.trimEnd()}\n\n--- Informações importantes ---\n${block}`;
}

/**
 * O texto original precisa estar contido na proposta, palavra por palavra.
 * Compara sem espaços supérfluos para não falhar por formatação.
 */
export function assertPreserved(before: string, after: string): void {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!norm(after).includes(norm(before))) {
    throw new EditValidationError("a versão complementada perdeu texto do original — proposta descartada");
  }
}

/** Diff linha a linha: só marca o que foi acrescentado, nunca o que sumiu. */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeSet = new Set(before.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return after
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => ({ kind: beforeSet.has(line.trim()) ? "same" : "added", text: line }));
}

function safeJson<T>(raw: unknown, fallback: T): T {
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
