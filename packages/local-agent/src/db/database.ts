/**
 * Camada de banco local: SQLite nativo (node:sqlite), WAL, foreign keys, migrations versionadas,
 * backup pré-alteração e recuperação. Fonte principal de verdade do modo local (§2.4).
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DbOptions {
  /** Caminho do arquivo .sqlite (ex.: %LOCALAPPDATA%/MarketplaceIntelligence/data/mi.sqlite). */
  file: string;
  /** Diretório das migrations SQL versionadas. */
  migrationsDir?: string;
  /** Diretório de backups automáticos. */
  backupDir?: string;
  /** Se true, mantém tudo em memória (testes). */
  memory?: boolean;
}

export class LocalDatabase {
  readonly db: DatabaseSync;
  readonly file: string;
  private readonly backupDir: string;
  private readonly migrationsDir: string;
  private txDepth = 0;

  constructor(opts: DbOptions) {
    this.file = opts.memory ? ':memory:' : resolve(opts.file);
    this.backupDir = opts.backupDir ?? join(dirname(this.file), 'backups');
    this.migrationsDir =
      opts.migrationsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

    if (!opts.memory) {
      mkdirSync(dirname(this.file), { recursive: true });
      mkdirSync(this.backupDir, { recursive: true });
    }

    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  /** Aplica todas as migrations pendentes. Idempotente e transacional por arquivo. */
  migrate(): { applied: number[]; skipped: number[] } {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);

    const files = existsSync(this.migrationsDir)
      ? readdirSync(this.migrationsDir)
          .filter((f) => /^\d+_.*\.sql$/.test(f))
          .sort()
      : [];

    const appliedRows = this.db
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all() as Array<{ version: number; checksum: string }>;
    const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row.checksum]));
    const seenVersions = new Set<number>();
    const migrations = files.map((file) => {
      const version = Number.parseInt(file.split('_')[0] as string, 10);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`versão de migration inválida: ${file}`);
      }
      if (seenVersions.has(version)) throw new Error(`versão de migration duplicada: ${version} (${file})`);
      seenVersions.add(version);
      const sql = readFileSync(join(this.migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { file, version, sql, checksum };
    });

    // A validação completa precede qualquer DDL: migration aplicada ausente ou alterada
    // não pode ser descoberta só depois que outras pendentes já foram executadas.
    for (const version of appliedByVersion.keys()) {
      if (!seenVersions.has(version)) {
        throw new Error(`migration ${version} já aplicada não existe no diretório; restaure o arquivo original`);
      }
    }
    for (const migration of migrations) {
      const appliedChecksum = appliedByVersion.get(migration.version);
      if (appliedChecksum !== undefined && appliedChecksum !== migration.checksum) {
        throw new Error(`migration ${migration.version} foi alterada depois de aplicada; restaure o arquivo original ou crie uma nova migration`);
      }
    }

    const applied: number[] = [];
    const skipped: number[] = [];

    for (const migration of migrations) {
      if (appliedByVersion.has(migration.version)) {
        skipped.push(migration.version);
        continue;
      }
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.file, new Date().toISOString(), migration.checksum);
      });
      applied.push(migration.version);
    }
    return { applied, skipped };
  }

  /** Executa e tipa o resultado de um SELECT (o driver devolve Record<string, SQLOutputValue>). */
  rows<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as unknown as T[];
  }

  /** Executa e tipa a primeira linha de um SELECT. */
  row<T>(sql: string, ...params: unknown[]): T | null {
    const r = this.db.prepare(sql).get(...(params as never[]));
    return (r as unknown as T) ?? null;
  }

  /** Executa em transação (suporta aninhamento por savepoint). */
  transaction<T>(fn: () => T): T {
    const isOuter = this.txDepth === 0;
    const savepoint = `sp_${this.txDepth}`;
    if (isOuter) this.db.exec('BEGIN IMMEDIATE');
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (isOuter) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.txDepth -= 1;
      if (isOuter) this.db.exec('ROLLBACK');
      else {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
      }
      throw err;
    }
  }

  /** Backup íntegro antes de qualquer alteração sensível (§18.3, §19). */
  backup(note: string): { path: string; bytes: number; checksum: string } {
    if (this.file === ':memory:') {
      return { path: ':memory:', bytes: 0, checksum: '' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.backupDir, `mi-${stamp}.sqlite`);
    // VACUUM INTO gera cópia consistente mesmo com WAL ativo.
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    const buf = readFileSync(path);
    const checksum = createHash('sha256').update(buf).digest('hex');
    this.db
      .prepare('INSERT INTO backups (id, created_at, path, bytes, kind, checksum, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), new Date().toISOString(), path, buf.byteLength, 'AUTO', checksum, note);
    return { path, bytes: buf.byteLength, checksum };
  }

  /** Integridade referencial e de arquivo. */
  integrityCheck(): { ok: boolean; messages: string[] } {
    const rows = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const messages = rows.map((r) => r.integrity_check).filter((m) => m !== 'ok');
    const fk = this.db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fk.length > 0) messages.push(`${fk.length} violações de chave estrangeira`);
    return { ok: messages.length === 0, messages };
  }

  tableCounts(): Record<string, number> {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const out: Record<string, number> = {};
    for (const t of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number };
      out[t.name] = row.c;
    }
    return out;
  }

  sizeBytes(): number {
    if (this.file === ':memory:') return 0;
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  /** Restaura um backup sobre o arquivo atual (mantendo o anterior como .bak). */
  static restore(backupPath: string, targetFile: string): void {
    if (!existsSync(backupPath)) throw new Error(`backup inexistente: ${backupPath}`);
    if (existsSync(targetFile)) copyFileSync(targetFile, `${targetFile}.pre-restore.bak`);
    copyFileSync(backupPath, targetFile);
  }
}
