/**
 * Servidor do painel HTTP local (§19, §31) e canal de fallback quando o Native
 * Messaging não está disponível (ex.: navegador sem o host registrado).
 *
 * Segurança:
 *  - Escuta apenas em 127.0.0.1 (nunca 0.0.0.0).
 *  - Exige token de sessão em todas as rotas /api, exceto /api/health.
 *  - Aceita apenas origens locais (chrome-extension:// da própria extensão e o painel).
 *  - Sem cookies: o token vai em cabeçalho Authorization.
 *
 * Estáticos:
 *  - `/` e `/prestart` servem a tela de Pré-Start.
 *  - `/app` serve o painel principal (index.html).
 *  - A escolha "sempre abrir direto no Dashboard" fica em arquivo no diretório
 *    de dados, para valer em qualquer navegador e depois de limpar o cache.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcResponse } from '@mi/shared';

export interface PanelServerOptions {
  port: number;
  token: string;
  /** Diretório com os arquivos estáticos do painel (HTML/CSS/JS compilados). */
  publicDir?: string;
  /** Chamada única para o serviço local (mesma do host nativo). */
  service: (request: unknown) => Promise<IpcResponse>;
  allowedExtensionIds?: string[];
  logger?: { info: (m: string) => void; error: (m: string, e?: unknown) => void };
  /** Arquivo que guarda a preferência de abrir direto no painel. */
  startTargetFile?: string;
  /**
   * Gera um token de sessão novo (o anterior deixa de valer). A tela de
   * Pré-Start usa isso no botão «Gerar novo token» da conexão manual.
   * Devolve o token novo e uma função que o grava como token corrente.
   */
  rotateToken?: () => { token: string };
  /**
   * Cria uma sessão nova no serviço (login real). Preferida sobre `rotateToken`:
   * trocar só o valor comparado pelo HTTP entregava um token que a API recusava.
   */
  issueToken?: () => Promise<string>;
  /**
   * Rotas extras, avaliadas antes dos estáticos. Usadas pela tela de pré-start
   * para diagnóstico do ambiente (navegador, host nativo, extensão, logs).
   */
  routes?: Array<{
    /** Caminho exato, ex.: `/api/prestart`. */
    path: string;
    /** GET/POST. */
    methods?: string[];
    /** Exige token de sessão (padrão: true). */
    requiresToken?: boolean;
    handler: (ctx: { req: IncomingMessage; url: URL; body: unknown }) => unknown | Promise<unknown>;
  }>;
}

export interface PanelServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isLocalOrigin(origin: string | undefined, allowedExtensionIds: string[]): boolean {
  if (!origin) return true; // chamadas nativas (curl, testes) não têm Origin
  if (origin === 'null') return false;
  if (allowedExtensionIds.some((id) => origin === `chrome-extension://${id}`)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

async function readJson(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('payload acima do limite');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(json);
}

/** Cria (sem escutar) o servidor do painel. */
export function createPanelServer(options: PanelServerOptions): PanelServer {
  const log = options.logger ?? { info: () => {}, error: () => {} };
  const allowed = options.allowedExtensionIds ?? [];
  let actualPort = options.port;
  /**
   * Token corrente do painel. Uma rotação troca aqui, não em `options.token`:
   * era essa cópia que deixava o token novo sem valor (as duas rotas seguintes
   * continuavam comparando com o token antigo).
   */
  let currentToken = options.token;

  /** «dashboard» quando o usuário marcou para não ver mais o Pré-Start. */
  const readStartTarget = (): string => {
    try {
      if (options.startTargetFile && existsSync(options.startTargetFile)) {
        return readFileSync(options.startTargetFile, 'utf8').trim();
      }
    } catch {
      /* preferência ilegível: trata como pré-start */
    }
    return 'prestart';
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      const origin = req.headers.origin;

      // Preflight CORS: só para origens locais conhecidas.
      if (req.method === 'OPTIONS') {
        if (origin && isLocalOrigin(origin, allowed)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'origin');
          res.setHeader('access-control-allow-headers', 'authorization, content-type');
          res.setHeader('access-control-allow-private-network', 'true');
          res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (!isLocalOrigin(origin, allowed)) {
        send(res, 403, { ok: false, error: { code: 'ORIGIN', message: 'origem não autorizada' } });
        return;
      }

      // Chamadas da extensão precisam de CORS também nas respostas normais.
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
      }

      /**
       * Token de sessão para a tela aberta em 127.0.0.1.
       *
       * Sem ele o painel ficava inutilizável quando a URL perdia o «?token=»
       * (favorito, histórico, limpeza de cache): todo botão respondia
       * "token de sessão ausente ou inválido". Só alcançável de 127.0.0.1 e de
       * origens locais, que é quem já vê o painel.
       */
      if (url.pathname === '/api/token') {
        const remote = req.socket.remoteAddress ?? '';
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
          send(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'somente 127.0.0.1' } });
          return;
        }
        send(res, 200, { ok: true, result: { token: currentToken, port: actualPort } });
        return;
      }

      /**
       * Novo token de sessão. Só de 127.0.0.1, como o anterior: quem já vê o
       * painel nesta máquina pode trocar a credencial, e o token antigo é
       * invalidado na hora (é o que «gerar novo token» significa).
       */
      if (url.pathname === '/api/token/rotate' && req.method === 'POST') {
        const remote = req.socket.remoteAddress ?? '';
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
          send(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'somente 127.0.0.1' } });
          return;
        }
        if (!options.issueToken && !options.rotateToken) {
          send(res, 501, { ok: false, error: { code: 'UNSUPPORTED', message: 'rotação de token indisponível' } });
          return;
        }
        // Sessão nova no serviço primeiro; só depois o HTTP passa a exigir o
        // token novo. Assim o token entregue à extensão é sempre válido na API.
        const fresh = options.issueToken
          ? await options.issueToken()
          : (options.rotateToken as () => { token: string })().token;
        if (!fresh) {
          send(res, 500, { ok: false, error: { code: 'ROTATE', message: 'não foi possível criar a sessão' } });
          return;
        }
        currentToken = fresh;
        send(res, 200, { ok: true, result: { token: currentToken, port: actualPort } });
        return;
      }

      if (url.pathname === '/api/health') {
        send(res, 200, { ok: true, protocolVersion: 1, uptimeSec: Math.round(process.uptime()) });
        return;
      }

      const extra = (options.routes ?? []).find((r) => r.path === url.pathname);
      if (extra) {
        const methods = extra.methods ?? ['GET'];
        if (!methods.includes(req.method ?? 'GET')) {
          send(res, 405, { ok: false, error: { code: 'METHOD', message: `use ${methods.join('/')}` } });
          return;
        }
        if (extra.requiresToken !== false) {
          const auth = req.headers.authorization ?? '';
          const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
          if (!provided || !safeEqual(provided, currentToken)) {
            send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'token de sessão ausente ou inválido' } });
            return;
          }
        }
        try {
          const body = req.method === 'POST' ? await readJson(req) : null;
          const result = await extra.handler({ req, url, body });
          send(res, 200, { ok: true, result });
        } catch (err) {
          log.error(`falha em ${extra.path}`, err);
          send(res, 500, { ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } });
        }
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const auth = req.headers.authorization ?? '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!provided || !safeEqual(provided, currentToken)) {
          send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'token de sessão ausente ou inválido' } });
          return;
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: { code: 'METHOD', message: 'use POST' } });
          return;
        }
        try {
          const body = await readJson(req);
          const response = await options.service(body);
          send(res, response.ok ? 200 : 400, response);
        } catch (err) {
          log.error('falha no /api', err);
          send(res, 500, {
            ok: false,
            error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
          });
        }
        return;
      }

      // Estáticos do painel (somente leitura, sem listagem de diretório).
      if (!options.publicDir) {
        send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'painel não compilado' } });
        return;
      }
      const requested = url.pathname;

      // Preferência guardada: com «dashboard», a raiz vai direto para o painel.
      if (requested === '/skip-prestart' || requested === '/prestart-preference') {
        send(res, 200, { ok: true, result: { target: readStartTarget() } });
        return;
      }

      let rel: string;
      if (requested === '/' || requested === '/prestart') {
        rel = readStartTarget() === 'dashboard' ? '/index.html' : '/prestart.html';
      } else if (requested === '/app') {
        rel = '/index.html';
      } else {
        rel = requested;
      }
      if (rel.includes('..')) {
        send(res, 400, { ok: false, error: { code: 'PATH', message: 'caminho inválido' } });
        return;
      }
      const file = join(options.publicDir, rel);
      if (!existsSync(file)) {
        send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: rel } });
        return;
      }
      const ext = rel.slice(rel.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    })();
  });

  return {
    server,
    get port() {
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : actualPort;
      return actualPort;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  } as PanelServer;
}

/** Cria e escuta o servidor do painel; devolve a porta efetiva. */
export async function startPanelServer(options: PanelServerOptions): Promise<PanelServer> {
  const panel = createPanelServer(options);
  await new Promise<void>((resolve, reject) => {
    panel.server.once('error', reject);
    panel.server.listen(options.port, '127.0.0.1', () => resolve());
  });
  return panel;
}
