/**
 * Entry point do serviço local (§20).
 *
 * Modos:
 *   --host   : fala o protocolo de mensagens nativas em stdin/stdout (sem logs em stdout)
 *   --serve  : sobe o painel HTTP local em 127.0.0.1 e mantém o processo vivo
 *   (padrão) : sobe o painel e também aceita o protocolo nativo em stdin
 *
 * Nenhuma credencial de marketplace é lida: o serviço trabalha apenas com o que a
 * extensão captura das páginas já autenticadas do usuário (§0.1).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AutoUpgradeEngine,
  CaptureService,
  GeminiClient,
  KnowledgeBase,
  LocalDatabase,
  LocalService,
  SecretStore,
  TaskScheduler,
} from './index';
import { createFileLogger, processNativeStream, encodeFrame } from './host-bridge';
import { spawn } from 'node:child_process';
import { startPanelServer, type PanelServer } from './server/panel-server';
import {
  buildPrestartReport,
  extensionStatus,
  logFiles,
  noteExtensionAlive,
  noteExtensionHandshake,
  extensionDiagnosis,
  extensionSessionToken,
  tailLog,
} from './server/prestart';

export interface BootstrapOptions {
  /** Diretório de dados (default: %LOCALAPPDATA%\MarketplaceIntelligence). */
  dataDir?: string;
  /** Diretório do painel compilado. */
  publicDir?: string;
  version?: string;
  port?: number;
  extensionIds?: string[];
  /** Diretório das migrações SQL (default: ao lado do bundle). */
  migrationsDir?: string;
  /** Pasta da extensão compilada (default: ao lado do programa). */
  extensionDir?: string;
}

/**
 * Abre a página de extensões do navegador a partir do serviço local.
 *
 * Não existe link que abra `edge://extensions`: o painel pede ao serviço, e o
 * serviço chama o navegador com `--extensions-url`. Se nenhum navegador
 * conhecido existir, devolve o que fazer em vez de falhar em silêncio.
 */
function openExtensionsPage(
  browser: 'chrome' | 'edge',
  panelUrl: string,
): { opened: boolean; browser: string; command?: string; note?: string } {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const candidates: Record<'chrome' | 'edge', string[]> = {
    chrome: [
      `${programFiles}/Google/Chrome/Application/chrome.exe`,
      `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
      `${localAppData}/Google/Chrome/Application/chrome.exe`,
    ],
    edge: [
      `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
      `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
    ],
  };
  const exe = candidates[browser].find((p) => existsSync(p));
  if (!exe) {
    return {
      opened: false,
      browser,
      note: `${browser === 'chrome' ? 'Chrome' : 'Edge'} não encontrado. Digite ${browser === 'chrome' ? 'edge' : 'edge'}://extensions na barra de endereços do seu navegador.`,
    };
  }
  const url = `http://127.0.0.1:${panelUrl}/prestart`;
  // spawn não espera o navegador: o serviço continua livre.
  spawnDetached(exe, ['--extensions-url', url]);
  return { opened: true, browser, command: exe };
}

function spawnDetached(exe: string, args: string[]): void {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** ID fixo da extensão (chave pública no manifest), gravado pelo instalador. */
function readExtensionId(dataDir: string): string {
  const file = join(dataDir, 'extension-id.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

export interface Bootstrap {
  db: LocalDatabase;
  service: LocalService;
  gemini: GeminiClient;
  version: string;
  /** Token de sessão usado pelo painel (trocado pela sessão real em `start`). */
  token: string;
  dataDir: string;
  close(): Promise<void>;
}

/** Monta todas as peças do serviço sobre um diretório de dados. */
export function bootstrap(options: BootstrapOptions = {}): Bootstrap {
  const dataDir = options.dataDir ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });

  const db = new LocalDatabase({
    file: join(dataDir, 'marketplace-intelligence.db'),
    // O bundle fica em dist/local-agent/main.js e as migrações ao lado dele.
    migrationsDir: options.migrationsDir ?? (existsSync(join(__dirname, 'migrations'))
      ? join(__dirname, 'migrations') : join(__dirname, '..', 'migrations')),
    backupDir: join(dataDir, 'backups'),
  });
  db.migrate();

  const secrets = new SecretStore(db, join(dataDir, 'secrets'));
  const gemini = new GeminiClient(db, secrets);
  const tasks = new TaskScheduler(db);
  const knowledge = new KnowledgeBase(db);
  const autoUpgrade = new AutoUpgradeEngine(db, gemini, dataDir);
  const capture = new CaptureService(db);

  const service = new LocalService({
    db,
    secrets,
    tasks,
    gemini,
    knowledge,
    autoUpgrade,
    capture,
    version: options.version ?? process.env.MI_VERSION ?? '3.15.0',
  });

  // Token de sessão do painel: gerado a cada início, nunca persistido em disco.
  const token = randomBytes(32).toString('hex');

  return {
    db,
    service,
    gemini,
    version: options.version ?? process.env.MI_VERSION ?? '3.15.0',
    token,
    dataDir,
    close: async () => {
      try {
        db.backup('shutdown');
      } catch {
        /* backup de saída é best-effort */
      }
      db.close();
    },
  };
}

export function defaultDataDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local');
  return join(base, 'MarketplaceIntelligence');
}

/** Executa o modo nativo: lê frames de stdin e responde em stdout. */
export async function runNativeHost(app: Bootstrap, logger = createFileLogger(join(app.dataDir, 'logs'))): Promise<void> {
  logger.info(`serviço local em modo nativo (pid ${process.pid})`);
  await processNativeStream(
    process.stdin,
    { logger, service: (req) => app.service.handle(req) },
    (response) => process.stdout.write(encodeFrame(response)),
  ).catch((err: unknown) => logger.error('falha ao processar stream Native Messaging', err));
}

export interface StartedApp extends Bootstrap {
  panel: PanelServer | null;
  url: string | null;
}

/**
 * Sessão inicial do painel: cria o super_admin no primeiro uso e devolve um
 * token de sessão para o painel abrir já autenticado. A senha nunca é fixa:
 * vem de MI_ADMIN_PASSWORD ou é gerada e exibida uma única vez no terminal.
 */
/**
 * Abre uma sessão nova para o administrador do painel, com login de verdade.
 *
 * Um UUID inventado não serve: a API exige sessão válida (`auth.session`
 * devolvia «sessão inválida»), então o «gerar novo token» precisa criar uma
 * linha em auth_sessions, não só trocar o valor que o servidor compara.
 */
export async function issuePanelSession(app: Bootstrap, dataDir = app.dataDir): Promise<string> {
  const email = process.env.MI_ADMIN_EMAIL ?? 'admin@marketplaceintelligence.local';
  const passwordFile = join(dataDir, 'admin-credentials.txt');
  const saved = existsSync(passwordFile)
    ? (readFileSync(passwordFile, 'utf8').split('\n')[1] ?? '').trim()
    : '';
  const password = process.env.MI_ADMIN_PASSWORD ?? saved;
  if (!password) return '';
  const login = await app.service.handle({
    id: 'rotate',
    protocolVersion: 1,
    method: 'auth.login',
    payload: { email, password },
  });
  return login.ok ? String((login.result as { token?: string }).token ?? '') : '';
}

export async function ensurePanelSession(app: Bootstrap, dataDir = app.dataDir): Promise<string> {
  // Zod exige e-mail válido: o domínio precisa de um TLD.
  const email = process.env.MI_ADMIN_EMAIL ?? 'admin@marketplaceintelligence.local';
  const passwordFile = join(dataDir, 'admin-credentials.txt');
  const saved = existsSync(passwordFile)
    ? (readFileSync(passwordFile, 'utf8').split('\n')[1] ?? '').trim()
    : '';
  let password = process.env.MI_ADMIN_PASSWORD ?? saved;

  const tryLogin = async (candidate: string): Promise<string> => {
    if (!candidate) return '';
    const login = await app.service.handle({
      id: 'boot',
      protocolVersion: 1,
      method: 'auth.login',
      payload: { email, password: candidate },
    });
    return login.ok ? String((login.result as { token?: string }).token ?? '') : '';
  };

  // Já existe usuário e a senha é conhecida: apenas abre a sessão.
  let token = await tryLogin(password);
  if (token) return token;

  // Primeiro uso (ou senha desconhecida): cria o super_admin com senha aleatória.
  password = password || randomBytes(9).toString('base64url');
  const boot = await app.service.handle({
    id: 'boot',
    protocolVersion: 1,
    method: 'auth.bootstrap',
    payload: { email, password, displayName: 'Administrador' },
  });
  if (boot.ok) {
    writeFileSync(passwordFile, `${email}\n${password}\n`, { encoding: 'utf8', mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(`super_admin criado — e-mail: ${email}`);
    // eslint-disable-next-line no-console
    console.log(`credenciais salvas em ${passwordFile} (arquivo local, acesso restrito)`);
    return tryLogin(password);
  }
  return '';
}

/**
 * Sobe o painel HTTP local e devolve a URL efetiva.
 *
 * O token do painel é o token de sessão do usuário inicial: a API exige uma
 * sessão válida (não basta conhecer o token do processo), então o serviço cria
 * ou reutiliza o super_admin no primeiro uso e usa a sessão dele no painel.
 */
export async function start(options: BootstrapOptions = {}): Promise<StartedApp> {
  const app = bootstrap(options);
  const sessionToken = await ensurePanelSession(app, options.dataDir ?? app.dataDir);
  if (sessionToken) app.token = sessionToken;
  // Painel compilado: ao lado do bundle em dist/local-agent/panel/dist.
  const publicDir = options.publicDir ?? join(__dirname, 'panel', 'dist');
  // Layout do instalador: {app}\local-agent\main.js e {app}\extension.
  const extensionDir = options.extensionDir ?? join(__dirname, '..', 'extension');
  const panel = await startPanelServer({
    port: options.port ?? 0,
    token: app.token,
    publicDir: existsSync(publicDir) ? publicDir : undefined,
    service: (req) => app.service.handle(req),
    /**
     * Origem autorizada da extensão: sem isto o serviço recusava o CORS do
     * painel lateral (403 «origem não autorizada»), e a extensão aparecia
     * como «serviço local indisponível» mesmo com o serviço no ar.
     * O ID é o fixo (chave pública no manifest), gravado pelo instalador.
     */
    allowedExtensionIds: options.extensionIds ?? [readExtensionId(app.dataDir)].filter(Boolean),
    logger: createFileLogger(join(app.dataDir, 'logs'), 'service.log'),
    startTargetFile: join(app.dataDir, 'start-target.txt'),
    /** Sessão nova de verdade para o «gerar novo token» (login real). */
    issueToken: () => issuePanelSession(app, options.dataDir ?? app.dataDir),
    /** Só atualiza o token compartilhado depois que a sessão anterior foi revogada. */
    onTokenRotated: (fresh) => {
      app.token = fresh;
      try {
        const port = panel.port || Number(readFileSync(join(app.dataDir, 'port.txt'), 'utf8').trim());
        writeFileSync(join(app.dataDir, 'panel-url.txt'), `http://127.0.0.1:${port}/?token=${fresh}`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        /* arquivo é conveniência do launcher: falhar aqui não invalida a sessão */
      }
      createFileLogger(join(app.dataDir, 'logs'), 'service.log').info('token de sessão do painel renovado');
    },
    routes: [
      {
        // Diagnóstico da tela de Pré-Start. Somente leitura, exige token.
        path: '/api/prestart',
        methods: ['GET'],
        handler: ({ url }) =>
          buildPrestartReport({
            db: app.db,
            dataDir: app.dataDir,
            version: app.version,
            port: panel.port,
            extensionDir,
            extensionCandidates: [
              join(__dirname, '..', 'extension'),
              join(__dirname, '..', '..', 'extension'),
              join(process.cwd(), 'extension'),
            ],
            extensionId: process.env.MI_EXTENSION_ID ?? readExtensionId(app.dataDir),
            geminiConfigured: () => app.gemini.hasKey(),
            geminiHint: () => app.gemini.keyHint(),
          }),
      },
      {
        path: '/api/prestart/logs',
        methods: ['GET'],
        handler: ({ url }) => {
          const file = url.searchParams.get('file');
          const level = url.searchParams.get('level') ?? undefined;
          const lines = Number(url.searchParams.get('lines') ?? 200);
          const known = logFiles(app.dataDir);
          const target = file && known.includes(file) ? file : known[0];
          if (!target) return { file: null, lines: [] };
          return { file: target, lines: tailLog(target, Math.min(Math.max(lines, 10), 2000), level) };
        },
      },
      {
        // A extensão chama aqui para dizer que está carregada.
        path: '/api/prestart/ping',
        methods: ['POST'],
        requiresToken: false,
        handler: ({ body }) => {
          const info = (body ?? {}) as {
            version?: string;
            marketplace?: string;
            tabTitle?: string;
            diagnosis?: unknown;
          };
          noteExtensionAlive(info);
          return { ok: true, receivedAt: new Date().toISOString() };
        },
      },
      {
        // Botões «Abrir extensões no Chrome/Edge»: só o processo do navegador
        // consegue abrir uma página interna como edge://extensions.
        path: '/api/prestart/open-extensions',
        methods: ['POST'],
        handler: async ({ body }) => {
          const browser = (body as { browser?: string } | null)?.browser === 'edge' ? 'edge' : 'chrome';
          return openExtensionsPage(browser, `${panel.port}`);
        },
      },
      {
        // Preferência: abrir direto no painel nas próximas vezes (ou voltar ao Pré-Start).
        path: '/api/prestart/start-target',
        methods: ['GET', 'POST'],
        requiresToken: true,
        handler: async ({ req, body }) => {
          const file = join(app.dataDir, 'start-target.txt');
          if (req.method === 'POST') {
            const target = (body as { target?: string } | null)?.target === 'dashboard' ? 'dashboard' : 'prestart';
            writeFileSync(file, target, 'utf8');
            return { target };
          }
          return { target: existsSync(file) ? readFileSync(file, 'utf8').trim() : 'prestart' };
        },
      },
      {
        // A tela de Pré-Start entrega à extensão o que só ela não consegue:
        // o token da sessão e a porta real do serviço.
        path: '/api/prestart/handshake',
        methods: ['POST'],
        handler: ({ body }) => {
          const data = (body ?? {}) as { token?: string; port?: number };
          noteExtensionHandshake({ token: data.token, port: data.port });
          const status = extensionStatus();
          return { extensionConnected: status.connected, port: panel.port };
        },
      },
      {
        path: '/api/prestart/extension',
        methods: ['GET'],
        // A extensão pergunta aqui o token e a porta; o ping seguinte já chega
        // autenticado sem exigir que o usuário copie nada.
        handler: () => ({
          ...extensionStatus(),
          diagnosis: extensionDiagnosis(),
          port: panel.port,
          sessionToken: extensionSessionToken(),
        }),
      },
      {
        path: '/api/prestart/tabtest',
        methods: ['POST'],
        handler: () => {
          const status = extensionStatus();
          if (!status.connected) {
            return {
              found: false,
              reason: 'a extensão ainda não falou com o serviço: carregue a pasta no navegador',
            };
          }
          return {
            found: Boolean(status.marketplace),
            marketplace: status.marketplace,
            title: status.tabTitle,
            lastCaptureAt: status.lastSeenAt,
          };
        },
      },
      {
        path: '/api/prestart/extension-path',
        methods: ['GET'],
        handler: () => ({ path: existsSync(join(extensionDir, 'manifest.json')) ? extensionDir : '' }),
      },
    ],
  });
  const port = panel.port;
  const scheduledWorkTimer = setInterval(() => {
    void app.service.processScheduledWork().catch((error: unknown) => {
      createFileLogger(join(app.dataDir, 'logs'), 'service.log').error('falha no ciclo de agendamentos', error);
    });
  }, 60_000);
  scheduledWorkTimer.unref();
  const originalClose = app.close;
  return {
    ...app,
    panel,
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      clearInterval(scheduledWorkTimer);
      await panel.close();
      await originalClose();
    },
  };
}

/** CLI mínima: sem dependências externas, apenas process.argv. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const mode = argv.includes('--host') ? 'host' : argv.includes('--serve') ? 'serve' : 'both';
  const portArg = argv.find((a) => a.startsWith('--port='));
  const dataArg = argv.find((a) => a.startsWith('--data='));

  const options: BootstrapOptions = {
    port: portArg ? Number(portArg.split('=')[1]) : 0,
    dataDir: dataArg ? dataArg.split('=')[1] : undefined,
  };
  if (mode === 'host') {
    const app = bootstrap(options);
    try { await runNativeHost(app); }
    finally { app.db.close(); }
    return;
  }

  const app = await start(options);
  const logger = createFileLogger(join(app.dataDir, 'logs'), 'service.log');
  // Token de sessão entra na URL apenas em 127.0.0.1 (nunca é persistido em disco).
  const panelUrl = `${app.url}?token=${app.token}`;
  // O token de sessão nunca vai para arquivo de log.
  logger.info(`painel local em ${app.url} (modo ${mode}) · pid ${process.pid}`);
  logger.info(`protocolo 1 · pasta de dados ${app.dataDir}`);

  if (mode === 'serve') {
    // O launcher (.cmd) precisa saber a porta e a URL sem ler stdout: grava os
    // dois arquivos no diretório de dados. Só existem em 127.0.0.1 e são
    // reescritos a cada início; o token nunca vai para log.
    try {
      writeFileSync(join(app.dataDir, 'port.txt'), String(app.panel?.port ?? 0), { encoding: 'utf8' });
      writeFileSync(join(app.dataDir, 'panel-url.txt'), panelUrl, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      logger.error('não foi possível gravar port.txt/panel-url.txt', err);
    }
    // eslint-disable-next-line no-console
    console.log(`Marketplace Intelligence — painel local: ${panelUrl}`);
    return;
  }

  void runNativeHost(app, logger);

  const shutdown = async () => {
    logger.info('encerrando serviço local');
    await app.panel?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
