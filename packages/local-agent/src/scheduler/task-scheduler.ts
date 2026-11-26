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

  list(status?: TaskState): TaskRecord[] {
    return status
      ? (this.db.rows<TaskRecord>('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC', status))
      : (this.db.rows<TaskRecord>('SELECT * FROM tasks ORDER BY created_at DESC'));
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
