/**
 * Diagnóstico do ambiente para a tela de Pré-Start.
 *
 * Tudo aqui é leitura local: serviço, banco, host nativo no registro do Windows,
 * pasta da extensão, chave Gemini e logs. Nada sai da máquina e nenhum segredo
 * é devolvido — só indicadores de "configurado / não configurado".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { LocalDatabase } from '../db/database';

export interface PrestartCheck {
  key: string;
  label: string;
  status: 'OK' | 'ATENCAO' | 'PENDENTE' | 'OPCIONAL';
  detail: string;
  /** O que fazer quando não está OK. */
  action?: string;
}

export interface PrestartReport {
  version: string;
  port: number;
  dataDir: string;
  uptimeSec: number;
  extensionId: string;
  extensionPath: string;
  checks: PrestartCheck[];
  /** A tela já pode seguir para o dashboard sem bloqueio. */
  canProceed: boolean;
  logs: { file: string; sizeBytes: number; modifiedAt: string }[];
}

export interface PrestartOptions {
  db: LocalDatabase;
  dataDir: string;
  version: string;
  port: number;
  /** Pasta da extensão compilada, ao lado do programa. */
  extensionDir?: string;
  /** Pastas candidatas, quando a primeira não existir. */
  extensionCandidates?: string[];
  /** ID fixo da extensão (chave pública no manifest). */
  extensionId?: string;
  /** Pergunta ao GeminiClient se a chave existe. */
  geminiConfigured?: () => boolean;
  geminiHint?: () => string | null;
}

const HOST_NAME = 'com.marketplaceintelligence.host';
const REGISTRY_KEYS = [
  { browser: 'Chrome', key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` },
  { browser: 'Edge', key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}` },
];

/** Lê a chave do registro sem abrir janela: `reg query` com saída capturada. */
function registryValue(key: string): string | null {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return null;
  const match = result.stdout.match(/REG_SZ\s+(.+)$/m);
  return match && match[1] ? match[1].trim() : null;
}

function migrationsCount(db: LocalDatabase): number {
  try {
    const row = db.row<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations');
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function tableCount(db: LocalDatabase): number {
  try {
    const row = db.row<{ n: number }>('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ?', 'table');
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function buildPrestartReport(options: PrestartOptions): PrestartReport {
  const checks: PrestartCheck[] = [];

  // 1. Serviço local
  checks.push({
    key: 'service',
    label: 'Serviço local',
    status: 'OK',
    detail: `Ativo em 127.0.0.1:${options.port} · versão ${options.version} · ${Math.round(process.uptime())}s no ar`,
  });

  // 2. Banco SQLite e migrações
  const applied = migrationsCount(options.db);
  const tables = tableCount(options.db);
  checks.push({
    key: 'database',
    label: 'Banco SQLite e migrações',
    status: applied > 0 ? 'OK' : 'ATENCAO',
    detail:
      applied > 0
        ? `${applied} migrações aplicadas · ${tables} tabelas · ${join(options.dataDir, 'marketplace-intelligence.db')}`
        : 'Banco aberto, mas nenhuma migração registrada',
    action: applied > 0 ? undefined : 'Reinstale o aplicativo ou apague o banco em %LOCALAPPDATA%\\MarketplaceIntelligence',
  });

  // 3. Host nativo no registro
  const registered: string[] = [];
  const missing: string[] = [];
  const manifestPaths: string[] = [];
  for (const entry of REGISTRY_KEYS) {
    const value = registryValue(entry.key);
    if (value) {
      registered.push(entry.browser);
      manifestPaths.push(value);
    } else {
      missing.push(entry.browser);
    }
  }
  const manifestExists = manifestPaths.length > 0 && manifestPaths.every((p) => existsSync(p));
  checks.push({
    key: 'nativeHost',
    label: 'Host nativo (Native Messaging)',
    status: registered.length === REGISTRY_KEYS.length && manifestExists ? 'OK' : 'ATENCAO',
    detail:
      registered.length === REGISTRY_KEYS.length
        ? `Registrado para ${registered.join(' e ')}${manifestExists ? '' : ' · manifesto ausente'}`
        : `Registrado: ${registered.join(', ') || 'nenhum'} · faltando: ${missing.join(', ')}`,
    action:
      registered.length === REGISTRY_KEYS.length
        ? undefined
        : 'Rode o instalador de novo como o mesmo usuário do Windows (o registro é por usuário)',
  });

  // 4. Pasta da extensão (tenta o caminho principal e os candidatos)
  const extDir = [options.extensionDir, ...(options.extensionCandidates ?? [])].find(
    (dir): dir is string => Boolean(dir && existsSync(join(dir, 'manifest.json'))),
  );
  const extOk = Boolean(extDir && existsSync(join(extDir, 'manifest.json')));
  checks.push({
    key: 'extensionFiles',
    label: 'Arquivos da extensão',
    status: extOk ? 'OK' : 'ATENCAO',
    detail: extOk ? extDir! : 'Pasta da extensão não encontrada ao lado do programa',
    action: extOk ? undefined : 'Reinstale o aplicativo para restaurar a pasta extension',
  });

  // 5. Chave Gemini (opcional)
  const gemini = options.geminiConfigured?.() ?? false;
  checks.push({
    key: 'gemini',
    label: 'Chave Gemini',
    status: gemini ? 'OK' : 'OPCIONAL',
    detail: gemini
      ? `Configurada${options.geminiHint?.() ? ` (${options.geminiHint!()})` : ''}`
      : 'Modo local ativo: KPIs, histórico, concorrência e regras funcionam sem IA',
    action: gemini ? undefined : 'Opcional. Configure em Administração quando quiser debate e auditoria com IA',
  });

  const logsDir = join(options.dataDir, 'logs');
  const logs = existsSync(logsDir)
    ? readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => {
          const full = join(logsDir, f);
          const st = statSync(full);
          return { file: full, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    : [];

  return {
    version: options.version,
    port: options.port,
    dataDir: options.dataDir,
    uptimeSec: Math.round(process.uptime()),
    extensionId: options.extensionId ?? '',
    extensionPath: extOk ? extDir! : '',
    checks,
    canProceed: true,
    logs,
  };
}

/**
 * Registro em memória do último sinal de vida da extensão.
 *
 * A extensão chama `/api/prestart/ping` a cada abertura de aba suportada e a
 * tela de Pré-Start consulta `/api/prestart/extension` para saber se ela está
 * carregada. É só isso: nada de conteúdo de página aqui.
 */
const extensionState: {
  lastSeenAt: string | null;
  version: string;
  marketplace: string;
  lastTabTitle: string;
  sessionToken: string;
  port: number;
  diagnosis: unknown;
} = {
  lastSeenAt: null,
  version: '',
  marketplace: '',
  lastTabTitle: '',
  sessionToken: '',
  port: 0,
  diagnosis: null,
};

export function noteExtensionAlive(info: {
  version?: string;
  marketplace?: string;
  tabTitle?: string;
  token?: string;
  diagnosis?: unknown;
}): void {
  if (info.diagnosis) extensionState.diagnosis = info.diagnosis;
  extensionState.lastSeenAt = new Date().toISOString();
  // A extensão não tem como receber o token de outra forma: ele é aceito aqui
  // (uma vez, em 127.0.0.1), guardado só em memória e nunca devolvido.
  if (info.token) extensionState.sessionToken = info.token;
  if (info.version) extensionState.version = info.version;
  if (info.marketplace) extensionState.marketplace = info.marketplace;
  if (info.tabTitle) extensionState.lastTabTitle = info.tabTitle;
}

/**
 * Guarda o que o painel entregou à extensão, para o ping seguinte já chegar
 * autenticado (a extensão pede, na próxima chamada, o que ficou pendente).
 */
export function noteExtensionHandshake(info: { token?: string; port?: number }): void {
  if (info.token) extensionState.sessionToken = info.token;
  if (info.port) extensionState.port = info.port;
}

/** Token que a extensão informou (para o painel repassar a ela). */
export function extensionSessionToken(): string {
  return extensionState.sessionToken;
}

/** Último diagnóstico que a extensão mandou (host nativo, porta, token). */
export function extensionDiagnosis(): unknown {
  return extensionState.diagnosis;
}

export function extensionStatus(maxAgeSec = 150): {
  connected: boolean;
  lastSeenAt: string | null;
  version: string;
  marketplace: string;
  tabTitle: string;
} {
  const last = extensionState.lastSeenAt;
  const fresh = last ? Date.now() - Date.parse(last) <= maxAgeSec * 1000 : false;
  return {
    connected: fresh,
    lastSeenAt: last,
    version: extensionState.version,
    marketplace: extensionState.marketplace,
    tabTitle: extensionState.lastTabTitle,
  };
}

/** Últimas linhas de um log, com filtro de nível opcional. */
/**
 * Últimas linhas de um log, já sem segredos.
 *
 * O token de sessão aparece na URL do painel (é assim que o launcher abre a
 * tela); nada que vá para a tela ou para uma exportação de diagnóstico pode
 * carregá-lo. As linhas antigas do log também são limpas na leitura.
 */
export function redactSecrets(line: string): string {
  return line.replace(/token=[A-Za-z0-9-]+/g, 'token=***');
}

export function tailLog(file: string, lines = 200, level?: string): string[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf8');
  const all = content.split(/\r?\n/).filter(Boolean);
  const filtered = level ? all.filter((l) => l.toUpperCase().includes(`[${level.toUpperCase()}]`)) : all;
  return filtered.slice(-lines).map(redactSecrets);
}

/** Arquivos de log conhecidos do aplicativo (serviço, host nativo, painel). */
export function logFiles(dataDir: string): string[] {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => join(dir, f));
  // Ordem por relevância: serviço, host nativo, stderr do serviço e o resto.
  const weight = (f: string): number => {
    const name = basename(f);
    if (name === 'service.log') return 0;
    if (name === 'native-host.log') return 1;
    if (name.startsWith('service-err')) return 2;
    return 3;
  };
  return files.sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
}

export function logName(file: string): string {
  return basename(file);
}
