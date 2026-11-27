/**
 * Camada de banco local: SQLite nativo (node:sqlite), WAL, foreign keys, migrations versionadas,
 * backup pré-alteração e recuperação. Fonte principal de verdade do modo local (§2.4).
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  db: DatabaseSync;
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

    this.db = this.openDatabase();
  }

  private openDatabase(): DatabaseSync {
    const connection = new DatabaseSync(this.file);
    connection.exec('PRAGMA journal_mode = WAL;');
    connection.exec('PRAGMA foreign_keys = ON;');
    connection.exec('PRAGMA busy_timeout = 5000;');
    connection.exec('PRAGMA synchronous = NORMAL;');
    return connection;
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
      const requiresForeignKeysOff = /^-- @requires_foreign_keys_off\s*$/m.test(migration.sql);
      if (requiresForeignKeysOff) this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.transaction(() => {
          this.db.exec(migration.sql);
          if (requiresForeignKeysOff) {
            const violations = this.db.prepare('PRAGMA foreign_key_check').all() as unknown[];
            if (violations.length > 0) {
              throw new Error(`migration ${migration.version} gerou ${violations.length} violações de chave estrangeira`);
            }
          }
          this.db
            .prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)')
            .run(migration.version, migration.file, new Date().toISOString(), migration.checksum);
        });
      } finally {
        if (requiresForeignKeysOff) this.db.exec('PRAGMA foreign_keys = ON');
      }
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
      if (isOuter) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      if (isOuter) this.db.exec('ROLLBACK');
      else {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** Backup íntegro antes de qualquer alteração sensível (§18.3, §19). */
  backup(note: string): { id: string; path: string; bytes: number; checksum: string } {
    if (this.file === ':memory:') {
      throw new Error('backup persistente não está disponível para banco em memória');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.backupDir, `mi-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
    // VACUUM INTO gera cópia consistente mesmo com WAL ativo.
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    const buf = readFileSync(path);
    const checksum = createHash('sha256').update(buf).digest('hex');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO backups (id, created_at, path, bytes, kind, checksum, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, new Date().toISOString(), path, buf.byteLength, 'AUTO', checksum, note);
    return { id, path, bytes: buf.byteLength, checksum };
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

  /** Restaura somente um backup registrado, checksum-validado e com esquema compatível. */
  restoreBackup(backupId: string): { backupId: string; restoredAt: string; previousFile: string; migrated: number[]; integrity: { ok: boolean; messages: string[] } } {
    if (this.file === ':memory:') throw new Error('restauração não está disponível para banco em memória');
    if (this.txDepth !== 0) throw new Error('não é possível restaurar durante uma transação');
    const record = this.row<{ path: string; checksum: string }>(
      'SELECT path,checksum FROM backups WHERE id=?', backupId,
    );
    if (!record) throw new Error('backup não encontrado no registro local');

    const backupRoot = realpathSync(this.backupDir);
    const backupPath = realpathSync(record.path);
    const rel = relative(backupRoot, backupPath);
    if (!rel || rel === '.' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error('o arquivo de backup está fora do diretório autorizado');
    }
    const bytes = readFileSync(backupPath);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== record.checksum) throw new Error('checksum do backup não corresponde ao registro');

    const validationDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const integrity = validationDb.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('backup reprovado no integrity_check');
      }
      const fkErrors = validationDb.prepare('PRAGMA foreign_key_check').all() as unknown[];
      if (fkErrors.length) throw new Error(`backup possui ${fkErrors.length} violações de chave estrangeira`);
      const table = validationDb.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() as { found: number } | undefined;
      if (!table) throw new Error('backup não contém o histórico de migrations');
      const applied = validationDb.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
      const available = readdirSync(this.migrationsDir).filter((f) => /^\d+_.*\.sql$/.test(f));
      const local = new Map(available.map((file) => {
        const version = Number.parseInt(file.split('_')[0] as string, 10);
        return [version, createHash('sha256').update(readFileSync(join(this.migrationsDir, file), 'utf8')).digest('hex')];
      }));
      for (const migration of applied) {
        if (local.get(migration.version) !== migration.checksum) {
          throw new Error(`backup possui migration ${migration.version} desconhecida ou com checksum divergente`);
        }
      }
    } finally {
      validationDb.close();
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const previousFile = `${this.file}.pre-restore-${stamp}-${randomUUID().slice(0, 8)}.bak`;
    const stagedFile = `${this.file}.restore-${randomUUID()}.tmp`;
    let originalClosed = false;
    let movedCurrent = false;
    let installedRestore = false;
    let openedRestore = false;
    try {
      // Prepare exatamente os bytes cujo checksum foi conferido, antes de tocar no banco vivo.
      writeFileSync(stagedFile, bytes, { flag: 'wx', mode: 0o600 });
      this.backup('pre-restore automático');
      const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      if (checkpoint.busy !== 0) throw new Error('banco ocupado: restauração cancelada antes da troca');
      this.db.close();
      originalClosed = true;
      renameSync(this.file, previousFile);
      movedCurrent = true;
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${this.file}${suffix}`;
        if (existsSync(sidecar)) rmSync(sidecar, { force: true });
      }
      renameSync(stagedFile, this.file);
      installedRestore = true;
      this.db = this.openDatabase();
      openedRestore = true;
      const migrationResult = this.migrate();
      // Uma cópia antiga não pode reviver credenciais ou repetir ações remotas já executadas.
      this.transaction(() => {
        const at = new Date().toISOString();
        this.db.prepare("UPDATE task_items SET draft_claim_token=NULL,draft_claimed_at=NULL WHERE status='PROCESSING'").run();
        this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(at);
        this.db.prepare(`UPDATE task_items SET status='UNCERTAIN',last_error='backup restaurado: confira o marketplace antes de qualquer nova publicação'
          WHERE id IN (SELECT item_id FROM task_publish_approvals WHERE status IN ('APPROVED','EXECUTING'))`).run();
        this.db.prepare(`UPDATE task_publish_approvals SET status='NEEDS_VERIFICATION',execution_finished_at=?,result_json=?
          WHERE status IN ('APPROVED','EXECUTING')`).run(at, JSON.stringify({ outcome: 'UNCERTAIN', message: 'autorização de backup antigo não pode ser reutilizada' }));
      });
      const finalIntegrity = this.integrityCheck();
      if (!finalIntegrity.ok) throw new Error(`banco restaurado falhou na verificação: ${finalIntegrity.messages.join('; ')}`);
      return { backupId, restoredAt: new Date().toISOString(), previousFile, migrated: migrationResult.applied, integrity: finalIntegrity };
    } catch (error) {
      if (openedRestore) { try { this.db.close(); } catch { /* preserva o erro original */ } }
      // Se a preparação ou o primeiro rename falhar, o original jamais é apagado.
      if (movedCurrent) {
        if (installedRestore && existsSync(this.file)) rmSync(this.file, { force: true });
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${this.file}${suffix}`;
          if (existsSync(sidecar)) rmSync(sidecar, { force: true });
        }
        if (existsSync(previousFile)) renameSync(previousFile, this.file);
      }
      if (originalClosed) this.db = this.openDatabase();
      if (existsSync(stagedFile)) rmSync(stagedFile, { force: true });
      throw error;
    }
  }
}
