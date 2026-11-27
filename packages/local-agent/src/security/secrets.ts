/**
 * Segredos locais: AES-256-GCM com chave derivada (DPAPI no Windows quando disponível).
 * A chave da API Gemini NUNCA vai para o frontend da extensão (§3).
 * Implementação: scrypt sobre um segredo de máquina + arquivo de chave com ACL do usuário.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { LocalDatabase } from '../db/database';

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
  method: string;
}

const KEY_FILE_NAME = 'master.key';
const SCRYPT_SALT = 'MarketplaceIntelligence::v1';

/**
 * Obtém o material de máquina: DPAPI (Windows) quando possível, senão arquivo 0600.
 * DPAPI protege a chave por usuário do Windows; o arquivo é a alternativa portátil.
 */
export function loadMachineSecret(baseDir: string): { secret: Buffer; method: string } {
  mkdirSync(baseDir, { recursive: true });
  const keyPath = join(baseDir, KEY_FILE_NAME);
  const dpapiPath = `${keyPath}.dpapi`;

  if (process.platform === 'win32') {
    const dpapi = tryDpapiUnprotect(dpapiPath);
    if (dpapi) return { secret: dpapi, method: 'DPAPI' };
  }

  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    return { secret: raw, method: process.platform === 'win32' ? 'FILE_ACL' : 'FILE_0600' };
  }

  const generated = randomBytes(32);
  if (process.platform === 'win32') {
    const protectedBlob = tryDpapiProtect(generated);
    if (protectedBlob) {
      writeFileSync(dpapiPath, protectedBlob, { mode: 0o600 });
      return { secret: generated, method: 'DPAPI' };
    }
  }
  writeFileSync(keyPath, generated, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* Windows ignora chmod */
  }
  return { secret: generated, method: 'FILE_ACL' };
}

/** DPAPI via PowerShell (sem addon nativo). Falha silenciosa → fallback em arquivo. */
function tryDpapiProtect(data: Buffer): Buffer | null {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$b = [Convert]::FromBase64String($env:MI_PLAIN);',
    '$p = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, "CurrentUser");',
    '[Console]::Out.Write([Convert]::ToBase64String($p));',
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MI_PLAIN: data.toString('base64') },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return Buffer.from(r.stdout.trim(), 'base64');
  } catch {
    return null;
  }
}

function tryDpapiUnprotect(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const blob = readFileSync(path);
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$b = [Convert]::FromBase64String($env:MI_CIPHER);',
    '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, "CurrentUser");',
    '[Console]::Out.Write([Convert]::ToBase64String($p));',
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MI_CIPHER: blob.toString('base64') },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return Buffer.from(r.stdout.trim(), 'base64');
  } catch {
    return null;
  }
}

export class SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly db: LocalDatabase,
    private readonly baseDir: string,
  ) {
    const { secret } = loadMachineSecret(baseDir);
    this.key = scryptSync(secret, SCRYPT_SALT, 32);
  }

  encrypt(plain: string): EncryptedBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      ciphertext: enc.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      method: 'AES-256-GCM',
    };
  }

  decrypt(blob: EncryptedBlob): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  }

  set(key: string, plain: string): void {
    const blob = this.encrypt(plain);
    this.db.db
      .prepare(
        `INSERT INTO secrets (key, ciphertext, iv, tag, method, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag,
           method=excluded.method, rotated_at=excluded.created_at`,
      )
      .run(key, blob.ciphertext, blob.iv, blob.tag, blob.method, new Date().toISOString());
  }

  get(key: string): string | null {
    const row = this.db.row<EncryptedBlob>('SELECT ciphertext, iv, tag, method FROM secrets WHERE key = ?', key);
    if (!row) return null;
    try {
      return this.decrypt(row);
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Metadados para exibição: nunca devolve o segredo, apenas um hint mascarado. */
  hint(key: string): string | null {
    const value = this.get(key);
    if (!value) return null;
    if (value.length <= 8) return '****';
    return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars, hash ${createHash('sha256').update(value).digest('hex').slice(0, 8)})`;
  }

  delete(key: string): void {
    this.db.db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
  }

  /** Remove todos os segredos de um namespace sem expor nem descriptografar seus valores. */
  deletePrefix(prefix: string): number {
    if (!prefix || prefix.length > 256) throw new Error('prefixo de segredo inválido');
    const result = this.db.db
      .prepare('DELETE FROM secrets WHERE substr(key, 1, ?) = ?')
      .run(prefix.length, prefix);
    return Number(result.changes);
  }
}

/** Hash de senha local (scrypt) com comparação em tempo constante. */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('base64');
  const hash = scryptSync(password, salt, 64).toString('base64');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'base64');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
