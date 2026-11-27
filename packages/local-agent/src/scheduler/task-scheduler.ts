/**
 * Fila e agendamento persistentes (§16).
 * Estados: PENDING, SCHEDULED, WAITING_BROWSER, RUNNING, PAUSED, COMPLETED, FAILED, CANCELLED.
 * Se o navegador estiver fechado no horário, a tarefa fica WAITING_BROWSER e é retomada
 * quando a sessão for validada. Retentativas são limitadas e idempotentes.
 */
import type { LocalDatabase } from '../db/database';
import { randomUUID } from 'node:crypto';

export const TASK_STATES = [
  'PENDING',
  'SCHEDULED',
  'WAITING_BROWSER',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface TaskRecord {
  id: string;
  account_id: string | null;
  name: string;
  kind: string;
  status: TaskState;
  mode: 'DRAFT' | 'PUBLISH';
  schedule_at: string | null;
  recurrence: string | null;
  typing_json: string;
  options_json: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface TaskItemRecord {
  id: string;
  task_id: string;
  listing_id: string;
  marketplace: string;
  account_id: string;
  copies: number;
  title: string | null;
  description_additions: string | null;
  cover_image_id: string | null;
  order_index: number;
  status: string;
  attempts: number;
  last_error: string | null;
  before_title?: string | null;
  before_description?: string | null;
  baseline_source_url?: string | null;
  baseline_captured_at?: string | null;
}

const nowIso = () => new Date().toISOString();

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ['SCHEDULED', 'RUNNING', 'WAITING_BROWSER', 'CANCELLED', 'PAUSED'],
  SCHEDULED: ['RUNNING', 'WAITING_BROWSER', 'PAUSED', 'CANCELLED', 'FAILED'],
  WAITING_BROWSER: ['RUNNING', 'SCHEDULED', 'PAUSED', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED', 'PAUSED', 'WAITING_BROWSER', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED', 'SCHEDULED', 'WAITING_BROWSER'],
  COMPLETED: [],
  FAILED: ['PENDING', 'SCHEDULED', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export class TaskScheduler {
  constructor(private readonly db: LocalDatabase) {}

  create(input: {
    name: string;
    kind: string;
    accountId?: string;
    mode: 'DRAFT' | 'PUBLISH';
    scheduleAt?: string | null;
    recurrence?: string | null;
    typing: Record<string, unknown>;
    options?: Record<string, unknown>;
    createdBy: string;
    items: Array<{
      listingId: string;
      marketplace: string;
      accountId: string;
      copies?: number;
      title?: string | null;
      descriptionAdditions?: string | null;
      coverImageId?: string | null;
    }>;
  }): { taskId: string; itemIds: string[] } {
    if (input.items.length === 0) throw new Error('tarefa sem itens');
    const taskId = randomUUID();
    const status: TaskState = input.scheduleAt ? 'SCHEDULED' : 'PENDING';
    const itemIds: string[] = [];
    this.db.transaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO tasks (id, account_id, name, kind, status, mode, schedule_at, recurrence, typing_json, options_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          input.accountId ?? null,
          input.name,
          input.kind,
          status,
          input.mode,
          input.scheduleAt ?? null,
          input.recurrence ?? null,
          JSON.stringify(input.typing),
          input.options ? JSON.stringify(input.options) : null,
          input.createdBy,
          nowIso(),
          nowIso(),
        );
      const stmt = this.db.db.prepare(
        `INSERT INTO task_items (id, task_id, listing_id, marketplace, account_id, copies, title, description_additions, cover_image_id, order_index, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0)`,
      );
      input.items.forEach((item, idx) => {
        const id = randomUUID();
        itemIds.push(id);
        stmt.run(
          id,
          taskId,
          item.listingId,
          item.marketplace,
          item.accountId,
          item.copies ?? 1,
          item.title ?? null,
          item.descriptionAdditions ?? null,
          item.coverImageId ?? null,
          idx,
        );
      });
    });
    return { taskId, itemIds };
  }

  get(taskId: string): TaskRecord | null {
    const row = this.db.row<TaskRecord>('SELECT * FROM tasks WHERE id = ?', taskId);
    return row ?? null;
  }

  items(taskId: string): TaskItemRecord[] {
    return this.db.rows<TaskItemRecord>('SELECT * FROM task_items WHERE task_id = ? ORDER BY order_index', taskId);
  }

  list(status?: TaskState, accountId?: string): TaskRecord[] {
    return this.db.rows<TaskRecord>(
      `SELECT t.* FROM tasks t
        WHERE (? IS NULL OR t.status=?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM task_items i WHERE i.task_id=t.id AND i.account_id=?))
        ORDER BY t.created_at DESC`,
      status ?? null, status ?? null, accountId ?? null, accountId ?? null,
    );
  }

  transition(taskId: string, to: TaskState, error?: string): void {
    const task = this.get(taskId);
    if (!task) throw new Error(`tarefa inexistente: ${taskId}`);
    if (task.status === to) return;
    if (!canTransition(task.status, to)) {
      throw new Error(`transição inválida ${task.status} → ${to}`);
    }
    this.db.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ?, last_error = ? WHERE id = ?')
      .run(to, nowIso(), error ?? task.last_error ?? null, taskId);
  }

  /**
   * Tarefas que devem começar agora. Sem navegador disponível → WAITING_BROWSER (nunca pula).
   */
  dueTasks(now: Date, browserAvailable: boolean): { due: TaskRecord[]; waiting: TaskRecord[] } {
    const due = this.db.rows<TaskRecord>(
      `SELECT * FROM tasks WHERE status IN ('PENDING','SCHEDULED')
         AND (schedule_at IS NULL OR schedule_at <= ?)
       ORDER BY COALESCE(schedule_at, created_at) ASC`,
      now.toISOString(),
    );
    const waiting: TaskRecord[] = [];
    if (!browserAvailable) {
      for (const t of due) {
        this.transition(t.id, 'WAITING_BROWSER', 'navegador indisponível no horário agendado');
        waiting.push({ ...t, status: 'WAITING_BROWSER' });
      }
      return { due: [], waiting };
    }
    return { due, waiting };
  }

  /** Retoma tarefas que aguardavam navegador após validação de sessão. */
  resumeWaiting(): TaskRecord[] {
    const rows = this.list('WAITING_BROWSER');
    for (const r of rows) this.transition(r.id, 'RUNNING');
    return rows;
  }

  resetExhaustedItemsForRetry(taskId: string): number {
    return this.db.transaction(() => {
      const changed = this.db.db.prepare(
        `UPDATE task_items SET status='PENDING',attempts=0,last_error=NULL
          WHERE task_id=? AND status='FAILED' AND attempts>=3`,
      ).run(taskId);
      return Number(changed.changes);
    });
  }

  skipNextItem(taskId: string): string {
    return this.db.transaction(() => {
      const item = this.db.row<{ id: string }>(
        `SELECT id FROM task_items WHERE task_id=? AND status IN ('PENDING','FAILED') ORDER BY order_index LIMIT 1`, taskId,
      );
      if (!item) throw new Error('não há item pendente para pular');
      this.db.db.prepare("UPDATE task_items SET status='SKIPPED',last_error='pulado pelo usuário' WHERE id=?").run(item.id);
      this.finalizeIfNoOpenItems(taskId);
      return item.id;
    });
  }

  skipItem(itemId: string): void {
    this.db.transaction(() => {
      const item = this.db.row<{ task_id: string; status: string }>('SELECT task_id,status FROM task_items WHERE id=?', itemId);
      if (!item) throw new Error('item da tarefa não encontrado');
      if (!['PENDING','FAILED'].includes(item.status)) throw new Error(`item não pode ser pulado no estado ${item.status}`);
      this.db.db.prepare("UPDATE task_items SET status='SKIPPED',last_error='pulado pelo usuário' WHERE id=?").run(itemId);
      this.finalizeIfNoOpenItems(item.task_id);
    });
  }

  private finalizeIfNoOpenItems(taskId: string): void {
    const counts = this.db.row<{ total: number; done: number; skipped: number; failed: number; open: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) AS skipped,
              SUM(CASE WHEN status='FAILED' AND attempts>=3 THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('PENDING','FAILED','PROCESSING') AND (status!='FAILED' OR attempts<3) THEN 1 ELSE 0 END) AS open
         FROM task_items WHERE task_id=?`, taskId,
    )!;
    if (counts.open !== 0) return;
    const task = this.get(taskId);
    if (!task || ['COMPLETED','FAILED','CANCELLED'].includes(task.status)) return;
    const finalStatus: TaskState = counts.failed > 0 ? 'FAILED' : 'COMPLETED';
    this.db.db.prepare('UPDATE tasks SET status=?,updated_at=?,last_error=? WHERE id=?')
      .run(finalStatus, nowIso(), counts.failed > 0 ? `${counts.failed} item(ns) falharam após 3 tentativas` : null, taskId);
    this.logRun(taskId, finalStatus, { total: counts.total, done: counts.done + counts.skipped, failed: counts.failed }, []);
  }

  markItemStatus(itemId: string, status: string, error?: string): void {
    this.db.db
      .prepare('UPDATE task_items SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?')
      .run(status, error ?? null, itemId);
  }

  /** Falhas isoladas: um item falhando não derruba a fila; retry limitado por item. */
  nextItem(taskId: string, maxAttempts = 3): TaskItemRecord | null {
    const item = this.db.row<TaskItemRecord>(
      `SELECT * FROM task_items WHERE task_id = ? AND status IN ('PENDING','FAILED') AND attempts < ? ORDER BY order_index LIMIT 1`,
      taskId,
      maxAttempts,
    );
    return item ?? null;
  }


  /** Reserva atomicamente um item DRAFT para o anúncio aberto na aba autenticada. */
  claimNextDraftItem(marketplace: string, externalListingId: string, accountId: string): {
    task: Pick<TaskRecord, 'id' | 'name' | 'kind' | 'mode' | 'typing_json'>;
    item: TaskItemRecord;
    externalListingId: string;
  } | { ambiguous: true } | null {
    return this.db.transaction(() => {
      this.db.db.prepare(
        `UPDATE tasks SET status='WAITING_BROWSER',updated_at=?,last_error='horário agendado atingido; aguardando aba do anúncio'
          WHERE status='SCHEDULED' AND mode='DRAFT' AND (schedule_at IS NULL OR schedule_at<=?)`,
      ).run(nowIso(), nowIso());
      const matches = this.db.rows<{
        task_id: string; task_name: string; task_kind: string; task_mode: 'DRAFT' | 'PUBLISH'; typing_json: string;
        item_id: string; listing_id: string; marketplace: string; account_id: string; copies: number;
        title: string | null; description_additions: string | null; cover_image_id: string | null;
        order_index: number; status: string; attempts: number; last_error: string | null; external_id: string;
      }>(
        `SELECT t.id AS task_id,t.name AS task_name,t.kind AS task_kind,t.mode AS task_mode,t.typing_json,
                i.id AS item_id,i.listing_id,i.marketplace,i.account_id,i.copies,i.title,i.description_additions,
                i.cover_image_id,i.order_index,i.status,i.attempts,i.last_error,l.external_id
           FROM tasks t JOIN task_items i ON i.task_id=t.id
           JOIN listings l ON l.id=i.listing_id AND l.account_id=i.account_id AND l.marketplace=i.marketplace
           JOIN accounts a ON a.id=i.account_id AND a.marketplace=i.marketplace AND a.is_active=1
          WHERE t.status IN ('RUNNING','WAITING_BROWSER') AND t.mode='DRAFT'
            AND t.kind IN ('edit_title','edit_description')
            AND i.status IN ('PENDING','FAILED') AND i.attempts < 3
            AND NOT EXISTS (SELECT 1 FROM task_items busy WHERE busy.account_id=i.account_id AND busy.listing_id=i.listing_id AND busy.status='PROCESSING')
            AND i.marketplace=? AND l.external_id=? AND i.account_id=?
          ORDER BY t.created_at,i.order_index LIMIT 2`,
        marketplace, externalListingId, accountId,
      );
      if (matches.length > 1) return { ambiguous: true } as const;
      const match = matches[0];
      if (!match) return null;
      const changed = this.db.db.prepare(
        `UPDATE task_items SET status='PROCESSING',attempts=attempts+1,last_error=NULL
          WHERE id=? AND status IN ('PENDING','FAILED') AND attempts < 3`,
      ).run(match.item_id);
      if (Number(changed.changes) !== 1) return null;
      const current = this.get(match.task_id);
      if (current?.status === 'WAITING_BROWSER') this.transition(current.id, 'RUNNING');
      const item: TaskItemRecord = {
        id: match.item_id, task_id: match.task_id, listing_id: match.listing_id,
        marketplace: match.marketplace, account_id: match.account_id, copies: match.copies,
        title: match.title, description_additions: match.description_additions,
        cover_image_id: match.cover_image_id, order_index: match.order_index,
        status: 'PROCESSING', attempts: match.attempts + 1, last_error: null,
      };
      return {
        task: { id: match.task_id, name: match.task_name, kind: match.task_kind, mode: match.task_mode, typing_json: match.typing_json },
        item,
        externalListingId: match.external_id,
      };
    });
  }

  /** Registra o resultado da edição em rascunho e fecha a tarefa quando todos os itens terminarem. */
  completeDraftItem(itemId: string, ok: boolean, message?: string): { taskId: string; taskStatus: TaskState; done: number; failed: number; total: number } {
    return this.db.transaction(() => {
      const item = this.db.row<{ task_id: string; attempts: number; status: string }>(
        'SELECT task_id,attempts,status FROM task_items WHERE id=?', itemId,
      );
      if (!item) throw new Error('item da tarefa não encontrado');
      if (item.status !== 'PROCESSING') throw new Error('item não está em execução');
      this.db.db.prepare('UPDATE task_items SET status=?,last_error=? WHERE id=?')
        .run(ok ? 'COMPLETED' : 'FAILED', ok ? null : (message ?? 'falha sem detalhe').slice(0, 1000), itemId);
      const counts = this.db.row<{ total: number; done: number; failed: number; open: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status='FAILED' AND attempts>=3 THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status IN ('PENDING','FAILED','PROCESSING') AND (status!='FAILED' OR attempts<3) THEN 1 ELSE 0 END) AS open
           FROM task_items WHERE task_id=?`, item.task_id,
      )!;
      const current = this.get(item.task_id);
      if (counts.open === 0 && current && ['RUNNING','WAITING_BROWSER'].includes(current.status)) {
        const finalStatus: TaskState = counts.failed > 0 ? 'FAILED' : 'COMPLETED';
        this.transition(item.task_id, finalStatus, counts.failed > 0 ? `${counts.failed} item(ns) falharam após 3 tentativas` : undefined);
        this.logRun(item.task_id, finalStatus, { total: counts.total, done: counts.done, failed: counts.failed }, []);
        const recurrenceMs: Record<string, number> = { '1h': 3600000, '6h': 21600000, daily: 86400000, weekly: 604800000 };
        const interval = current.recurrence ? recurrenceMs[current.recurrence] : undefined;
        if (finalStatus === 'COMPLETED' && interval) {
          const nextAt = new Date(Date.now() + interval).toISOString();
          this.db.db.prepare("UPDATE task_items SET status='PENDING',attempts=0,last_error=NULL WHERE task_id=?").run(item.task_id);
          this.db.db.prepare("UPDATE tasks SET status='SCHEDULED',schedule_at=?,updated_at=?,last_error=NULL WHERE id=?")
            .run(nextAt, nowIso(), item.task_id);
        }
      }
      const finalTask = this.get(item.task_id);
      return { taskId: item.task_id, taskStatus: finalTask?.status ?? 'FAILED', done: counts.done, failed: counts.failed, total: counts.total };
    });
  }

  counts(): Record<TaskState, number> {
    const rows = this.db.rows<{ status: TaskState; c: number }>(
      'SELECT status, COUNT(*) AS c FROM tasks GROUP BY status',
    );
    const out = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  logRun(taskId: string, status: string, totals: { total: number; done: number; failed: number }, log: unknown[]): string {
    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO task_runs (id, task_id, started_at, finished_at, status, items_total, items_done, items_failed, log_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, nowIso(), nowIso(), status, totals.total, totals.done, totals.failed, JSON.stringify(log));
    return id;
  }
}
