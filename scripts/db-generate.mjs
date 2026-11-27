/**
 * Gera um snapshot SQL determinístico do schema efetivamente criado pelas migrations.
 * Requer Node >=22.13 (node:sqlite). Não altera o banco de dados do usuário.
 * Uso: npm run db:generate [-- --out caminho] [--check]
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(root, 'packages', 'local-agent', 'migrations');
const args = process.argv.slice(2);
let output = join(root, 'dist', 'database', 'schema.sql');
let checkOnly = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--check') checkOnly = true;
  else if (arg === '--out') {
    const next = args[i + 1];
    if (!next || next.startsWith('--')) throw new Error('informe o caminho depois de --out');
    output = resolve(process.cwd(), next);
    i += 1;
  } else {
    throw new Error(`argumento não reconhecido: ${arg}`);
  }
}

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
if (!migrationFiles.length) throw new Error('nenhuma migration SQL encontrada');

const versions = new Set();
const db = new DatabaseSync(':memory:');
try {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  );`);

  const applied = [];
  for (const file of migrationFiles) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (!Number.isSafeInteger(version) || version < 1 || versions.has(version)) {
      throw new Error(`versão de migration inválida ou duplicada: ${file}`);
    }
    versions.add(version);
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const foreignKeysOff = /^-- @requires_foreign_keys_off\s*$/m.test(sql);
    if (foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec('BEGIN IMMEDIATE;');
      db.exec(sql);
      if (foreignKeysOff) {
        const violations = db.prepare('PRAGMA foreign_key_check;').all();
        if (violations.length) throw new Error(`${file} criou ${violations.length} violações de chave estrangeira`);
      }
      db.prepare('INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (?,?,?,?)')
        .run(version, file, new Date(0).toISOString(), checksum);
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* a transação pode já ter sido revertida */ }
      throw new Error(`falha ao aplicar ${file}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (foreignKeysOff) db.exec('PRAGMA foreign_keys = ON;');
    }
    applied.push({ version, file, checksum });
  }

  const integrity = db.prepare('PRAGMA integrity_check;').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`integridade SQLite inválida: ${JSON.stringify(integrity)}`);
  }
  const fkErrors = db.prepare('PRAGMA foreign_key_check;').all();
  if (fkErrors.length) throw new Error(`schema contém ${fkErrors.length} violações de chave estrangeira`);

  const objects = db.prepare(`
    SELECT type, name, sql
      FROM sqlite_schema
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END,
              name COLLATE NOCASE
  `).all();
  const lines = [
    '-- Gerado por scripts/db-generate.mjs; não editar manualmente.',
    `-- Migrations: ${applied.map((m) => `${String(m.version).padStart(3, '0')}:${m.file}`).join(', ')}`,
    '-- Banco criado e validado em memória; foreign_key_check=0; integrity_check=ok.',
    'PRAGMA foreign_keys = ON;',
    '',
  ];
  for (const object of objects) {
    lines.push(`-- ${object.type}: ${object.name}`);
    lines.push(String(object.sql).trim().replace(/;?$/, ';'));
    lines.push('');
  }
  const schema = `${lines.join('\n').trim()}\n`;
  if (!checkOnly) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, schema, 'utf8');
  }
  console.log(`OK migrations=${applied.length} objetos=${objects.length} integridade=ok foreign_keys=0${checkOnly ? ' (check-only)' : ` arquivo=${output}`}`);
} finally {
  db.close();
}
