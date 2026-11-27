/** Smoke test SQLite do fluxo de aprovação/publicação/rollback assistido.
 * Não acessa marketplace: valida isolamento, consumo único e persistência da evidência.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(process.cwd(), 'packages', 'local-agent', 'migrations');
const files = readdirSync(migrationsDir).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
const db = new DatabaseSync(':memory:');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const now = '2026-11-27T12:00:00.000Z';
try {
  db.exec('PRAGMA foreign_keys=ON;');
  for (const file of files) db.exec(readFileSync(join(migrationsDir, file), 'utf8'));

  db.prepare(`INSERT INTO accounts (id,marketplace,display_name,detection_confidence,verified_by_user,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('acct-a', 'mercado_livre', 'Loja A', 1, 1, 1, now, now);
  db.prepare(`INSERT INTO accounts (id,marketplace,display_name,detection_confidence,verified_by_user,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('acct-b', 'mercado_livre', 'Loja B', 1, 1, 1, now, now);
  db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'ACTIVE',?,?)`).run('listing-a', 'acct-a', 'mercado_livre', 'MLB-A', 'Título antigo', now, now);
  db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'ACTIVE',?,?)`).run('listing-b', 'acct-b', 'mercado_livre', 'MLB-A', 'Título outra conta', now, now);
  db.prepare(`INSERT INTO tasks (id,name,kind,status,mode,typing_json,created_by,created_at,updated_at)
    VALUES (?,?,?,'COMPLETED','DRAFT',?,?,?,?)`).run('task-a', 'Publicação assistida', 'edit_title', '{}', 'super-admin', now, now);
  db.prepare(`INSERT INTO task_items (id,task_id,listing_id,marketplace,account_id,copies,title,status,before_title,before_description,baseline_source_url,baseline_captured_at)
    VALUES (?,?,?,?,?,1,?,'APPROVED_TO_PUBLISH',?,?,?,?)`)
    .run('item-a', 'task-a', 'listing-a', 'mercado_livre', 'acct-a', 'Título novo', 'Título antigo', 'Descrição original', 'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLB-A', now);
  db.prepare(`INSERT INTO task_publish_approvals (id,task_id,item_id,account_id,marketplace,external_listing_id,status,approved_by,approved_at,expires_at,reason)
    VALUES (?,?,?,?,?,?,'APPROVED',?,?,?,?)`)
    .run('approval-a', 'task-a', 'item-a', 'acct-a', 'mercado_livre', 'MLB-A', 'super-admin', now, '2026-11-27T12:15:00.000Z', 'Revisão manual');

  const exact = db.prepare(`SELECT a.id,a.item_id FROM task_publish_approvals a
    JOIN task_items i ON i.id=a.item_id AND i.account_id=a.account_id
    JOIN listings l ON l.id=i.listing_id AND l.account_id=i.account_id AND l.marketplace=i.marketplace
    JOIN accounts ac ON ac.id=a.account_id AND ac.marketplace=a.marketplace AND ac.is_active=1 AND ac.verified_by_user=1
    WHERE a.status='APPROVED' AND a.account_id=? AND a.external_listing_id=?`).get('acct-a', 'MLB-A');
  assert(exact?.id === 'approval-a', 'a aprovação não foi localizada para a conta/anúncio exatos');
  const wrongAccount = db.prepare(`SELECT a.id FROM task_publish_approvals a WHERE a.status='APPROVED' AND a.account_id=? AND a.external_listing_id=?`).get('acct-b', 'MLB-A');
  assert(!wrongAccount, 'a aprovação vazou para outra conta com mesmo ID externo');

  const claim = db.prepare("UPDATE task_publish_approvals SET status='EXECUTING',execution_started_at=? WHERE id=? AND status='APPROVED'").run(now, 'approval-a');
  assert(Number(claim.changes) === 1, 'a aprovação não pôde ser consumida');
  const replay = db.prepare("UPDATE task_publish_approvals SET status='EXECUTING' WHERE id=? AND status='APPROVED'").run('approval-a');
  assert(Number(replay.changes) === 0, 'a aprovação pôde ser consumida mais de uma vez');

  // Simula uma corrida entre aprovação e alteração concorrente do item: se o
  // segundo UPDATE não encontrar o estado esperado, toda a transação reverte.
  db.prepare(`INSERT INTO tasks (id,name,kind,status,mode,typing_json,created_by,created_at,updated_at)
    VALUES (?,?,?,'COMPLETED','DRAFT',?,?,?,?)`).run('task-b', 'Corrida concorrente', 'edit_title', '{}', 'super-admin', now, now);
  db.prepare(`INSERT INTO task_items (id,task_id,listing_id,marketplace,account_id,copies,title,status)
    VALUES (?,?,?,?,?,1,?,'COMPLETED')`).run('item-b', 'task-b', 'listing-b', 'mercado_livre', 'acct-b', 'Outro título');
  db.prepare(`INSERT INTO task_publish_approvals (id,task_id,item_id,account_id,marketplace,external_listing_id,status,approved_by,approved_at,expires_at,reason)
    VALUES (?,?,?,?,?,?,'APPROVED',?,?,?,?)`).run('approval-b', 'task-b', 'item-b', 'acct-b', 'mercado_livre', 'MLB-A', 'super-admin', now, '2026-11-27T12:15:00.000Z', 'concorrência');
  let rolledBack = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE task_publish_approvals SET status='EXECUTING' WHERE id=? AND status='APPROVED'").run('approval-b');
    const staleItem = db.prepare("UPDATE task_items SET status='PUBLISHING' WHERE id=? AND status='APPROVED_TO_PUBLISH'").run('item-b');
    if (Number(staleItem.changes) !== 1) throw new Error('estado concorrente detectado');
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    rolledBack = true;
  }
  assert(rolledBack && db.prepare('SELECT status FROM task_publish_approvals WHERE id=?').get('approval-b')?.status === 'APPROVED'
    && db.prepare('SELECT status FROM task_items WHERE id=?').get('item-b')?.status === 'COMPLETED', 'mudança concorrente deixou autorização órfã em vez de reverter a transação');

  const finish = db.prepare("UPDATE task_publish_approvals SET status='PUBLISHED',execution_finished_at=?,result_json=? WHERE id=? AND status='EXECUTING'")
    .run(now, JSON.stringify({ outcome: 'PUBLISHED', before: 'Título antigo', after: 'Título novo' }), 'approval-a');
  assert(Number(finish.changes) === 1, 'não foi possível concluir o estado publicado');
  db.prepare("UPDATE task_items SET status='PUBLISHED' WHERE id=? AND status='PUBLISHING'").run('item-a');
  db.prepare(`INSERT INTO change_sets (id,account_id,listing_id,field,before_text,after_text,diff_json,preservation_ok,verified_after_save,applied_at,actor_user_id,task_id)
    VALUES (?,?,?,?,?,?,?,1,1,?,?,?)`)
    .run('change-a', 'acct-a', 'listing-a', 'title', 'Título antigo', 'Título novo', '{}', now, 'super-admin', 'task-a');
  const rollback = db.prepare(`SELECT before_text,after_text FROM change_sets WHERE task_id=? AND listing_id=? AND field='title'`).get('task-a', 'listing-a');
  assert(rollback?.before_text === 'Título antigo' && rollback.after_text === 'Título novo', 'a evidência não preservou o valor original para rollback');

  let duplicateRejected = false;
  try {
    db.prepare(`INSERT INTO task_publish_approvals (id,task_id,item_id,account_id,marketplace,external_listing_id,status,approved_by,approved_at,expires_at,reason)
      VALUES (?,?,?,?,?,?,'APPROVED',?,?,?,?)`).run('approval-duplicate', 'task-a', 'item-a', 'acct-a', 'mercado_livre', 'MLB-A', 'super-admin', now, '2026-11-27T12:15:00.000Z', 'duplicate');
  } catch { duplicateRejected = true; }
  assert(duplicateRejected, 'o banco aceitou segunda autorização para o mesmo item');
  assert(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'integrity_check falhou');
  assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign_key_check encontrou violações');
  console.log(`OK publication-smoke migrations=${files.length} checks=10 isolation=ok one-shot=ok concurrent-rollback=ok rollback-evidence=ok integrity=ok`);
} finally {
  db.close();
}
