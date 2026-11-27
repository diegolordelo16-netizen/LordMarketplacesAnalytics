/** Smoke tests sem Vitest: executáveis com as APIs nativas do Node >=22.13. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseCsvText, parseXlsxBase64 } from '../packages/local-agent/src/importers/tabular.ts';
import { parsePdfBase64 } from '../packages/local-agent/src/importers/pdf.ts';
import { firstOccurrence, intervalFor, nextOccurrence, retryDecision, retryOccurrence } from '../packages/local-agent/src/scheduler/cadence.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const passed = [];
const test = (name, fn) => { fn(); passed.push(name); };

test('CSV: separador, aspas, duplicidade de cabeçalho e campos multilinha', () => {
  const rows = parseCsvText('Nome;Valor\r\n"Produto; Azul";10\r\n"Linha 1\nLinha 2";20\r\n"Com aspas ""ok""";30');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].Nome, 'Produto; Azul');
  assert.equal(rows[1].Nome, 'Linha 1\nLinha 2');
  assert.deepEqual(parseCsvText('sku,sku\nA,1'), [{ sku: 'A', sku_2: '1' }]);
  assert.throws(() => parseCsvText('a,b\n"sem fechar,1'), /aspas sem fechamento/);
});

test('XLSX: planilha ZIP comprimida e tipos de célula', () => {
  const xlsx = readFileSync(join(root, 'packages/local-agent/test/fixtures/tabular-mini.xlsx'));
  const rows = parseXlsxBase64(xlsx.toString('base64'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Indicador, 'revenue');
  assert.equal(rows[0].Valor, 1234.5);
  assert.equal(rows[1].Valor, true);
});

test('PDF: extrai texto de PDF digital com suporte Poppler opcional e fallback', () => {
  const pdf = readFileSync(join(root, 'packages/local-agent/test/fixtures/digital-report.pdf'));
  const result = parsePdfBase64(pdf.toString('base64'));
  assert.match(result.text, /Relatorio de vendas/);
  assert.match(result.text, /12\.345,67/);
  assert.match(result.text, /123/);
  assert.ok(result.rows.length >= 3);
  assert.throws(() => parsePdfBase64(Buffer.from('not a PDF').toString('base64')), /PDF/);
});

test('PDF: fallback sem Poppler lê ASCII85 + Flate com dicionário multilinha', () => {
  const pdf = readFileSync(join(root, 'packages/local-agent/test/fixtures/digital-report.pdf'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const result = parsePdfBase64(pdf.toString('base64'));
    assert.match(result.text, /Relatorio de vendas/);
    assert.match(result.text, /12\.345,67/);
    assert.match(result.text, /Pedidos: 123/);
    assert.ok(result.warnings.some((warning) => warning.includes('fallback embutido')));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test('cadência: intervalo customizado aceita 15 a 43200 minutos', () => {
  assert.equal(intervalFor('custom', 15), 900_000);
  assert.equal(intervalFor('custom', 43_200), 2_592_000_000);
  assert.throws(() => intervalFor('custom', 14), /15 e 43200/);
  assert.throws(() => intervalFor('custom', 43_201), /15 e 43200/);
  assert.throws(() => intervalFor('custom', 15.5), /15 e 43200/);
});

test('cadência: próxima execução preserva âncora e pula períodos perdidos', () => {
  const previous = '2026-11-27T00:00:00.000Z';
  const next = nextOccurrence(previous, '1h', null, new Date('2026-11-27T03:20:00.000Z'));
  assert.equal(next, '2026-11-27T04:00:00.000Z');
  const custom = nextOccurrence(previous, '1h', 30, new Date('2026-11-27T01:10:00.000Z'));
  assert.equal(custom, '2026-11-27T01:30:00.000Z');
  assert.equal(firstOccurrence('custom', 45, new Date('2026-11-27T00:00:00.000Z')), '2026-11-27T00:45:00.000Z');
});

test('retentativa: backoff crescente e limite de três tentativas', () => {
  const now = new Date('2026-11-27T00:00:00.000Z');
  assert.equal(retryOccurrence(1, now), '2026-11-27T00:05:00.000Z');
  assert.equal(retryOccurrence(2, now), '2026-11-27T00:15:00.000Z');
  assert.equal(retryOccurrence(3, now), '2026-11-27T01:00:00.000Z');
  assert.deepEqual(retryDecision(0, now), { consecutiveFailures: 1, shouldRetry: true, nextRunAt: '2026-11-27T00:05:00.000Z' });
  assert.deepEqual(retryDecision(1, now), { consecutiveFailures: 2, shouldRetry: true, nextRunAt: '2026-11-27T00:15:00.000Z' });
  assert.deepEqual(retryDecision(2, now), { consecutiveFailures: 3, shouldRetry: true, nextRunAt: '2026-11-27T01:00:00.000Z' });
  assert.deepEqual(retryDecision(3, now), { consecutiveFailures: 3, shouldRetry: false, nextRunAt: null });
  assert.throws(() => retryOccurrence(4, now), /fora do limite/);
  assert.throws(() => retryDecision(4, now), /fora do limite/);
});

test('SQLite: todas as migrations, tabelas de histórico e limites de intervalo', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL,checksum TEXT NOT NULL);');
    const dir = join(root, 'packages/local-agent/migrations');
    const files = readdirSync(dir).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort((a,b) => Number(a.split('_')[0])-Number(b.split('_')[0]));
    for (const file of files) db.exec(readFileSync(join(dir,file),'utf8'));
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('analysis_schedule_runs'));
    assert.ok(tables.includes('report_schedule_runs'));
    assert.ok(tables.includes('sync_schedules'));
    assert.ok(tables.includes('sync_schedule_runs'));
    assert.ok(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('analysis_schedules') WHERE name='interval_minutes'").get());
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('report_schedules') WHERE name='consecutive_failures'").get());

    const now = '2026-11-27T00:00:00.000Z';
    db.prepare('INSERT INTO users(id,email,display_name,role,password_hash,password_salt,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run('user-admin-smoke','admin-smoke@example.test','Admin Smoke','super_admin','hash','salt',now);
    db.prepare('INSERT INTO users(id,email,display_name,role,password_hash,password_salt,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run('user-view-smoke','viewer-smoke@example.test','Viewer Smoke','visualizador','hash','salt',now);
    assert.equal(db.prepare("SELECT COUNT(*) total FROM users WHERE role IN ('super_admin','operador','visualizador')").get().total,2);
    assert.throws(() => db.prepare('INSERT INTO users(id,email,display_name,role,password_hash,password_salt,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run('user-invalid-smoke','bad-smoke@example.test','Bad','unknown','hash','salt',now));
    assert.throws(() => db.prepare('INSERT INTO users(id,email,display_name,role,password_hash,password_salt,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run('user-dup-smoke','admin-smoke@example.test','Duplicate','operador','hash','salt',now));
    db.prepare('INSERT INTO accounts(id,marketplace,display_name,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('acct-smoke','mercado_livre','Loja Smoke',now,now);
    db.prepare(`INSERT INTO analysis_schedules
      (id,account_id,mode,days,cadence,enabled,next_run_at,created_at,updated_at,interval_minutes,consecutive_failures)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run('analysis-smoke','acct-smoke','PADRAO',30,'1h',1,'2026-11-27T00:45:00.000Z',now,now,45,0);
    db.prepare(`INSERT INTO analysis_schedule_runs
      (id,schedule_id,started_at,finished_at,status,result_json,duration_ms)
      VALUES(?,?,?,?,?,?,?)`)
      .run('analysis-run-smoke','analysis-smoke',now,now,'COMPLETED','{"ok":true}',25);
    assert.equal(db.prepare('SELECT interval_minutes FROM analysis_schedules WHERE id=?').get('analysis-smoke').interval_minutes,45);
    assert.equal(db.prepare('SELECT status FROM analysis_schedule_runs WHERE id=?').get('analysis-run-smoke').status,'COMPLETED');
    assert.throws(() => db.prepare(`INSERT INTO analysis_schedules
      (id,mode,days,cadence,enabled,next_run_at,created_at,updated_at,interval_minutes)
      VALUES('bad-interval','PADRAO',30,'1h',1,?,?,?,14)`).run(now,now,now));

    db.prepare(`INSERT INTO report_schedules
      (id,account_id,report_type,format,cadence,enabled,next_run_at,created_at,updated_at,interval_minutes,consecutive_failures)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run('report-smoke','acct-smoke','EXECUTIVO','json','1h',1,'2026-11-27T01:30:00.000Z',now,now,90,0);
    db.prepare(`INSERT INTO report_schedule_runs
      (id,schedule_id,generated_at,status,report_json,row_count)
      VALUES(?,?,?,?,?,?)`)
      .run('report-run-smoke','report-smoke',now,'COMPLETED','{"rows":[]}',0);
    assert.equal(db.prepare('SELECT report_json FROM report_schedule_runs WHERE id=?').get('report-run-smoke').report_json,'{"rows":[]}');

    db.prepare(`INSERT INTO sync_schedules
      (id,scope,account_id,cadence,interval_minutes,enabled,next_run_at,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?,?)`)
      .run('sync-schedule-smoke','ALL_ACTIVE_ACCOUNTS',null,'1h',30,'2026-11-27T00:30:00.000Z',now,now);
    db.prepare(`INSERT INTO sync_batches(id,requested_by,scope,status,requested_at,summary_json)
      VALUES(?,NULL,?,'QUEUED',?,?)`)
      .run('sync-batch-smoke','ALL_ACTIVE_ACCOUNTS',now,'{"scheduled":true}');
    db.prepare(`INSERT INTO sync_batch_accounts(id,batch_id,account_id,marketplace,status)
      VALUES(?,?,?,?,?)`)
      .run('sync-account-smoke','sync-batch-smoke','acct-smoke','mercado_livre','WAITING_BROWSER');
    db.prepare(`INSERT INTO sync_schedule_runs(id,schedule_id,batch_id,scheduled_at,status,summary_json)
      VALUES(?,?,?,?,'QUEUED','{"accountCount":1}')`)
      .run('sync-run-smoke','sync-schedule-smoke','sync-batch-smoke',now);
    const claimed = db.prepare("UPDATE sync_schedule_runs SET status='RUNNING',started_at=? WHERE id=? AND status='QUEUED'").run(now,'sync-run-smoke');
    assert.equal(Number(claimed.changes),1);
    const duplicateClaim = db.prepare("UPDATE sync_schedule_runs SET status='RUNNING',started_at=? WHERE id=? AND status='QUEUED'").run(now,'sync-run-smoke');
    assert.equal(Number(duplicateClaim.changes),0);
    assert.equal(db.prepare('SELECT status FROM sync_schedule_runs WHERE id=?').get('sync-run-smoke').status,'RUNNING');
    // Retry manual deve copiar apenas contas falhas/ignoradas ativas e nunca duplicar conta já pendente.
    db.prepare(`INSERT INTO accounts(id,marketplace,display_name,created_at,updated_at) VALUES(?,?,?,?,?)`)
      .run('acct-failed','shopee','Loja Falha',now,now);
    db.prepare(`INSERT INTO accounts(id,marketplace,display_name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run('acct-inactive','amazon','Loja Inativa',0,now,now);
    db.prepare(`INSERT INTO sync_batches(id,scope,status,requested_at,summary_json) VALUES(?,?,'PARTIAL',?,'{}')`)
      .run('sync-original','ALL_ACTIVE_ACCOUNTS',now);
    const originalAccount = db.prepare('INSERT INTO sync_batch_accounts(id,batch_id,account_id,marketplace,status) VALUES(?,?,?,?,?)');
    originalAccount.run('orig-failed','sync-original','acct-failed','shopee','FAILED');
    originalAccount.run('orig-partial','sync-original','acct-smoke','mercado_livre','PARTIAL');
    originalAccount.run('orig-inactive','sync-original','acct-inactive','amazon','SKIPPED');
    const eligibleRetries = db.prepare(`SELECT ba.account_id FROM sync_batch_accounts ba JOIN accounts a ON a.id=ba.account_id
      WHERE ba.batch_id=? AND ba.status IN ('FAILED','PARTIAL','SKIPPED') AND a.is_active=1
      AND NOT EXISTS (SELECT 1 FROM sync_batch_accounts pending JOIN sync_batches b ON b.id=pending.batch_id
        WHERE pending.account_id=ba.account_id AND pending.status IN ('WAITING_BROWSER','RUNNING') AND b.status IN ('QUEUED','RUNNING'))
      ORDER BY ba.account_id`).all('sync-original');
    assert.deepEqual(eligibleRetries.map((r) => r.account_id), ['acct-failed']);
    // Uma conta já em outro lote ativo não pode entrar no novo lote de repetição.
    db.prepare(`INSERT INTO sync_batches(id,scope,status,requested_at,summary_json) VALUES(?,?,'QUEUED',?,'{}')`)
      .run('sync-pending','ALL_ACTIVE_ACCOUNTS',now);
    db.prepare(`INSERT INTO sync_batch_accounts(id,batch_id,account_id,marketplace,status) VALUES(?,?,?,?,?)`)
      .run('pending-account','sync-pending','acct-failed','shopee','WAITING_BROWSER');
    assert.equal(db.prepare(`SELECT COUNT(*) total FROM sync_batch_accounts ba JOIN accounts a ON a.id=ba.account_id
      WHERE ba.batch_id=? AND ba.status IN ('FAILED','PARTIAL','SKIPPED') AND a.is_active=1
      AND NOT EXISTS (SELECT 1 FROM sync_batch_accounts pending JOIN sync_batches b ON b.id=pending.batch_id
        WHERE pending.account_id=ba.account_id AND pending.status IN ('WAITING_BROWSER','RUNNING') AND b.status IN ('QUEUED','RUNNING'))`).get('sync-original').total,0);
    const staleStartedAt = '2026-11-26T00:00:00.000Z';
    db.prepare('UPDATE sync_schedule_runs SET started_at=? WHERE id=?').run(staleStartedAt,'sync-run-smoke');
    const staleReclaim = db.prepare("UPDATE sync_schedule_runs SET status='RUNNING',started_at=? WHERE id=? AND (status='QUEUED' OR (status='RUNNING' AND started_at<=?))").run(now,'sync-run-smoke','2026-11-26T12:00:00.000Z');
    assert.equal(Number(staleReclaim.changes),1);
    assert.equal(db.prepare('SELECT interval_minutes FROM sync_schedules WHERE id=?').get('sync-schedule-smoke').interval_minutes,30);
    assert.throws(() => db.prepare(`INSERT INTO sync_schedules
      (id,scope,cadence,interval_minutes,enabled,next_run_at,created_at,updated_at)
      VALUES('sync-bad','ALL_ACTIVE_ACCOUNTS','1h',43201,1,?,?,?)`).run(now,now,now));
    db.prepare(`INSERT INTO sync_schedules
      (id,scope,account_id,cadence,enabled,next_run_at,created_at,updated_at)
      VALUES('sync-account-schedule','ACCOUNT','acct-smoke','daily',1,?,?,?)`).run(now,now,now);
    assert.equal(db.prepare('SELECT account_id FROM sync_schedules WHERE id=?').get('sync-account-schedule').account_id,'acct-smoke');
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('sync_batch_accounts') WHERE name='progress_json'").get());
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('sync_batch_accounts') WHERE name='current_page_no'").get());
    const pageRun = db.prepare(`INSERT INTO sync_batch_page_runs
      (id,batch_id,account_id,page_no,page_url,page_kind,status,error,queued,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    pageRun.run('page-run-1','sync-batch-smoke','acct-smoke',1,'https://vendedores.mercadolivre.com.br/resumo','seller_dashboard','COMPLETED',null,0,now);
    pageRun.run('page-run-2','sync-batch-smoke','acct-smoke',2,'https://vendedores.mercadolivre.com.br/pedidos?page=2','seller_orders','COMPLETED',null,0,now);
    const resumeState = { seenUrls:['https://vendedores.mercadolivre.com.br/resumo','https://vendedores.mercadolivre.com.br/pedidos?page=2'], pendingLinks:[{url:'https://vendedores.mercadolivre.com.br/anuncios',label:'Anúncios'}], pages:[{page:1,url:'https://vendedores.mercadolivre.com.br/resumo',pageKind:'seller_dashboard',ok:true},{page:2,url:'https://vendedores.mercadolivre.com.br/pedidos?page=2',pageKind:'seller_orders',ok:true}], maxPages:8, stoppedReason:'worker interrompido' };
    db.prepare(`UPDATE sync_batch_accounts SET pages_scanned=2,pages_succeeded=2,current_page_no=2,current_url=?,progress_json=?,progress_updated_at=? WHERE id=?`)
      .run('https://vendedores.mercadolivre.com.br/pedidos?page=2',JSON.stringify(resumeState),now,'sync-account-smoke');
    const persistedProgress = db.prepare('SELECT * FROM sync_batch_accounts WHERE id=?').get('sync-account-smoke');
    const recoveredState = JSON.parse(persistedProgress.progress_json);
    assert.equal(persistedProgress.pages_scanned,2);
    assert.equal(persistedProgress.current_page_no,2);
    assert.equal(recoveredState.pages.length,2);
    assert.equal(recoveredState.pendingLinks[0].label,'Anúncios');
    assert.deepEqual(db.prepare('SELECT page_no,status FROM sync_batch_page_runs WHERE batch_id=? ORDER BY page_no').all('sync-batch-smoke').map((r)=>[r.page_no,r.status]),[[1,'COMPLETED'],[2,'COMPLETED']]);
    db.prepare(`INSERT INTO sync_batch_page_runs(id,batch_id,account_id,page_no,page_url,page_kind,status,error,queued,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,account_id,page_no) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`).run('page-run-2-retry','sync-batch-smoke','acct-smoke',2,'https://vendedores.mercadolivre.com.br/pedidos?page=2','seller_orders','COMPLETED',null,0,now);
    assert.equal(db.prepare('SELECT COUNT(*) total FROM sync_batch_page_runs WHERE batch_id=? AND account_id=?').get('sync-batch-smoke','acct-smoke').total,2);
    db.prepare("UPDATE sync_batch_page_runs SET status='QUEUED' WHERE batch_id=? AND account_id=? AND page_no=2").run('sync-batch-smoke','acct-smoke');
    assert.equal(db.prepare('SELECT status FROM sync_batch_page_runs WHERE batch_id=? AND account_id=? AND page_no=2').get('sync-batch-smoke','acct-smoke').status,'QUEUED');
    db.prepare("UPDATE sync_batch_page_runs SET status='COMPLETED' WHERE batch_id=? AND account_id=? AND page_no=2").run('sync-batch-smoke','acct-smoke');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally { db.close(); }
});

console.log(`Smoke local: ${passed.length}/${passed.length} aprovados.`);
for (const name of passed) console.log(`OK ${name}`);
