/**
 * Central de Melhorias — o único caminho pelo qual o software muda de
 * comportamento permanente, e ele passa por UMA pessoa.
 *
 * A regra é imposta aqui, no serviço local, não na interface:
 *   - propor: qualquer sessão pareada;
 *   - aprovar/rejeitar: apenas OWNER_PRINCIPAL, e a checagem é feita de novo
 *     a cada chamada (não existe "sessão de admin" que valha para sempre).
 *
 * Esconder o botão na UI não é controle de acesso. Isto é.
 */
import type { LocalDatabase } from "../database/db.js";

export type ImprovementKind = "rule" | "adapter" | "metric" | "ui" | "prompt";
export type ImprovementStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "APPLIED";

export interface Improvement {
  id: string;
  createdAt: string;
  title: string;
  rationale: string;
  kind: ImprovementKind;
  payload: string;
  status: ImprovementStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export class OwnerRequiredError extends Error {
  readonly code = "IMPROVEMENT_NOT_APPROVED";
  constructor() {
    super("Somente o OWNER_PRINCIPAL pode aprovar ou rejeitar melhorias permanentes.");
  }
}

export class ImprovementService {
  constructor(private readonly db: LocalDatabase) {}

  /** Id do proprietário principal (único, garantido por índice no schema). */
  ownerId(): string | null {
    const row = this.db
      .raw()
      .prepare("SELECT id FROM accounts WHERE is_owner = 1 LIMIT 1")
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Cria o OWNER_PRINCIPAL na primeira execução. Idempotente. */
  ensureOwner(displayName = "Proprietário"): string {
    const existing = this.ownerId();
    if (existing) return existing;
    const id = crypto.randomUUID();
    this.db
      .raw()
      .prepare("INSERT INTO accounts (id, display_name, is_owner, created_at) VALUES (?, ?, 1, ?)")
      .run(id, displayName, new Date().toISOString());
    return id;
  }

  propose(input: {
    title: string;
    rationale: string;
    kind: ImprovementKind;
    payload: Record<string, unknown>;
  }): Improvement {
    if (!input.title.trim()) throw new Error("TITLE_REQUIRED");
    if (!input.rationale.trim()) throw new Error("RATIONALE_REQUIRED");
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .raw()
      .prepare(
        `INSERT INTO improvements (id, created_at, title, rationale, kind, payload, status)
         VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED')`,
      )
      .run(id, createdAt, input.title.trim(), input.rationale.trim(), input.kind, JSON.stringify(input.payload));
    return this.get(id)!;
  }

  get(id: string): Improvement | null {
    const row = this.db.raw().prepare("SELECT * FROM improvements WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapImprovement(row) : null;
  }

  list(status?: ImprovementStatus): Improvement[] {
    const rows = (
      status
        ? this.db
            .raw()
            .prepare("SELECT * FROM improvements WHERE status = ? ORDER BY created_at DESC")
            .all(status)
        : this.db.raw().prepare("SELECT * FROM improvements ORDER BY created_at DESC").all()
    ) as Record<string, unknown>[];
    return rows.map(mapImprovement);
  }

  /**
   * Aprova. Recusa quem não é o proprietário — verificação no serviço, sempre.
   */
  approve(id: string, actorId: string | null, note?: string): Improvement {
    return this.decide(id, actorId, "APPROVED", note);
  }

  reject(id: string, actorId: string | null, note?: string): Improvement {
    return this.decide(id, actorId, "REJECTED", note);
  }

  private decide(
    id: string,
    actorId: string | null,
    status: "APPROVED" | "REJECTED",
    note?: string,
  ): Improvement {
    const owner = this.ownerId();
    if (!owner || actorId !== owner) throw new OwnerRequiredError();

    const current = this.get(id);
    if (!current) throw new Error("IMPROVEMENT_NOT_FOUND");
    if (current.status !== "PROPOSED") {
      throw new Error(`INVALID_TRANSITION: ${current.status} -> ${status}`);
    }

    this.db
      .raw()
      .prepare("UPDATE improvements SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
      .run(status, actorId, new Date().toISOString(), note ?? null, id);
    return this.get(id)!;
  }

  /** Marca como aplicada — só depois de aprovada. */
  markApplied(id: string, actorId: string | null): Improvement {
    const owner = this.ownerId();
    if (!owner || actorId !== owner) throw new OwnerRequiredError();
    const current = this.get(id);
    if (!current) throw new Error("IMPROVEMENT_NOT_FOUND");
    if (current.status !== "APPROVED") throw new Error(`INVALID_TRANSITION: ${current.status} -> APPLIED`);
    this.db.raw().prepare("UPDATE improvements SET status = 'APPLIED' WHERE id = ?").run(id);
    return this.get(id)!;
  }
}

function mapImprovement(r: Record<string, unknown>): Improvement {
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    title: String(r.title),
    rationale: String(r.rationale),
    kind: String(r.kind) as ImprovementKind,
    payload: String(r.payload),
    status: String(r.status) as ImprovementStatus,
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    decidedAt: r.decided_at === null ? null : String(r.decided_at),
    decisionNote: r.decision_note === null ? null : String(r.decision_note),
  };
}
