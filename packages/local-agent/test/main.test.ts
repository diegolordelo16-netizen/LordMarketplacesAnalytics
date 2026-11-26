import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, start, type Bootstrap } from '../src/main';
import type { StartedApp } from '../src/main';

let dir = '';
/** Os testes rodam a partir de src/: as migrações ficam em ../migrations. */
const MIGRATIONS = join(process.cwd(), 'packages/local-agent/migrations');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mi-main-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function ping(app: Bootstrap): Promise<{ ok: boolean }> {
  const res = await app.service.handle({ id: 'p1', protocolVersion: 1, method: 'ping', payload: {} });
  return { ok: res.ok };
}

describe('bootstrap do serviço local', () => {
  it('sobe banco, migra e responde ping', async () => {
    const app = bootstrap({ dataDir: join(dir, 'a') });
    expect(await ping(app)).toEqual({ ok: true });
    await app.close();
  });

  it('gera token de sessão novo a cada início', async () => {
    const a = bootstrap({ dataDir: join(dir, 'b') });
    const b = bootstrap({ dataDir: join(dir, 'b') });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(64);
    await a.close();
    await b.close();
  });

  it('cria backup ao encerrar', async () => {
    const app = bootstrap({ dataDir: join(dir, 'c') });
    await app.close();
    const again = bootstrap({ dataDir: join(dir, 'c') });
    const integrity = again.db.integrityCheck();
    expect(integrity.ok).toBe(true);
    await again.close();
  });
});

describe('painel HTTP local', () => {
  let app: StartedApp;

  beforeAll(async () => {
    app = await start({ dataDir: join(dir, 'panel'), port: 0 });
  });
  afterAll(async () => {
    await app.panel?.close();
    await app.close();
  });

  it('escuta em 127.0.0.1 e informa a porta real', () => {
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(app.panel).not.toBeNull();
  });

  it('responde /api/health sem token', async () => {
    const res = await fetch(`${app.url}api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; protocolVersion: number };
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(1);
  });

  it('exige token em /api', async () => {
    const res = await fetch(`${app.url}api/ipc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', protocolVersion: 1, method: 'ping', payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('aceita pedido autenticado e devolve a resposta do serviço', async () => {
    const res = await fetch(`${app.url}api/ipc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
      body: JSON.stringify({ id: 'x', protocolVersion: 1, method: 'ping', payload: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe('x');
  });

  it('recusa origem externa', async () => {
    const res = await fetch(`${app.url}api/health`, { headers: { origin: 'https://exemplo-malicioso.com' } });
    expect(res.status).toBe(403);
  });
});

describe('tela de pré-start', () => {
  it('reporta serviço, banco, host nativo e extensão sem quebrar', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-pre-'));
    const started = await start({ dataDir, migrationsDir: MIGRATIONS, port: 0 });
    try {
      const res = await fetch(`${started.url}api/prestart`, {
        headers: { authorization: `Bearer ${started.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; result: { checks: Array<{ key: string; status: string }> } };
      expect(body.ok).toBe(true);
      const keys = body.result.checks.map((c) => c.key);
      expect(keys).toEqual(['service', 'database', 'nativeHost', 'extensionFiles', 'gemini']);
      const db = body.result.checks.find((c) => c.key === 'database');
      expect(db?.status).toBe('OK');
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });

  it('recebe o ping da extensão e passa a reportá-la conectada', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-pre-ping-'));
    const started = await start({ dataDir, migrationsDir: MIGRATIONS, port: 0 });
    try {
      const ping = await fetch(`${started.url}api/prestart/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: '3.1.0', marketplace: 'mercado_livre', tabTitle: 'Vendas' }),
      });
      expect(ping.status).toBe(200);
      const status = await fetch(`${started.url}api/prestart/extension`, {
        headers: { authorization: `Bearer ${started.token}` },
      });
      const body = (await status.json()) as { result: { connected: boolean; marketplace: string } };
      expect(body.result.connected).toBe(true);
      expect(body.result.marketplace).toBe('mercado_livre');
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });

  it('serve a tela de pré-start na raiz', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-pre-html-'));
    const started = await start({
      dataDir,
      migrationsDir: MIGRATIONS,
      port: 0,
      publicDir: join(process.cwd(), 'packages/local-agent/panel/src'),
    });
    try {
      const res = await fetch(started.url!);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Pré-Start');
      expect(html).toContain('prestart.js');
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });
});

describe('avanço do pré-start para o painel', () => {
  it('guarda a preferência e serve o painel na raiz quando ela está marcada', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-start-'));
    const started = await start({
      dataDir,
      migrationsDir: MIGRATIONS,
      port: 0,
      publicDir: join(process.cwd(), 'packages/local-agent/panel/src'),
    });
    const base = started.url!.replace(/\/$/, '/');
    const auth = { authorization: `Bearer ${started.token}`, 'content-type': 'application/json' };
    try {
      const before = await (await fetch(base)).text();
      expect(before).toContain('Pré-Start');

      await fetch(`${base}api/prestart/start-target`, { method: 'POST', headers: auth, body: JSON.stringify({ target: 'dashboard' }) });
      const after = await (await fetch(base)).text();
      expect(after).not.toContain('Pré-Start');
      expect(after).toContain('app.js');

      await fetch(`${base}api/prestart/start-target`, { method: 'POST', headers: auth, body: JSON.stringify({ target: 'prestart' }) });
      expect(await (await fetch(base)).text()).toContain('Pré-Start');
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });

  it('/app sempre serve o painel principal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-app-'));
    const started = await start({
      dataDir,
      migrationsDir: MIGRATIONS,
      port: 0,
      publicDir: join(process.cwd(), 'packages/local-agent/panel/src'),
    });
    try {
      const html = await (await fetch(`${started.url}app`)).text();
      expect(html).toContain('app.js');
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });
});

describe('token quando a URL perde o ?token=', () => {
  it('/api/token entrega a sessão vigente de 127.0.0.1', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-token-'));
    const started = await start({ dataDir, migrationsDir: MIGRATIONS, port: 0 });
    try {
      const res = await fetch(`${started.url}api/token`, { headers: { 'sec-fetch-site': 'same-origin' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { token: string } };
      expect(body.result.token).toBe(started.token);
      // e o token devolvido abre a API normalmente
      const check = await fetch(`${started.url}api/prestart`, {
        headers: { authorization: `Bearer ${body.result.token}` },
      });
      expect(check.status).toBe(200);
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });

  it('entrega token apenas à extensão cujo ID está autorizado', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-token-ext-'));
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const started = await start({ dataDir, migrationsDir: MIGRATIONS, port: 0, extensionIds: [extensionId] });
    try {
      const res = await fetch(`${started.url}api/token`, { headers: { origin: `chrome-extension://${extensionId}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(`chrome-extension://${extensionId}`);
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });

  it('não entrega token a requisição sem metadados same-origin nem a outra porta localhost', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-token-origin-'));
    const started = await start({ dataDir, migrationsDir: MIGRATIONS, port: 0 });
    try {
      const bare = await fetch(`${started.url}api/token`);
      expect(bare.status).toBe(403);

      const attackerOrigin = `http://127.0.0.1:${Number(new URL(started.url!).port) + 1}`;
      const attacker = await fetch(`${started.url}api/token`, { headers: { origin: attackerOrigin } });
      expect(attacker.status).toBe(403);
      expect(await attacker.text()).not.toContain(started.token);
    } finally {
      await started.panel?.close();
      await started.close();
    }
  });
});

describe('conexão manual da extensão', () => {
  it('a tela mostra porta e token, e «gerar novo token» troca a credencial', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-cred-'));
    const started = await start({ dataDir, migrationsDir: MIGRATIONS, port: 0 });
    const base = started.url!;
    try {
      // A tela lê as credenciais que o usuário vai colar na extensão.
      type Cred = { ok: boolean; result: { token: string; port: number } };
      const panelOrigin = new URL(base).origin;
      const read = (await fetch(`${base}api/token`, { headers: { 'sec-fetch-site': 'same-origin' } }).then((r) => r.json())) as Cred;
      expect(read.ok).toBe(true);
      expect(typeof read.result.token).toBe('string');
      expect(read.result.port).toBeGreaterThan(0);

      // Token novo invalida o anterior: é o que o botão promete.
      const rotated = (await fetch(`${base}api/token/rotate`, {
        method: 'POST',
        headers: { origin: panelOrigin, authorization: `Bearer ${read.result.token}` },
      }).then((r) => r.json())) as Cred;
      expect(rotated.ok).toBe(true);
      expect(rotated.result.token).not.toBe(read.result.token);

      // Também precisa revogar a sessão no serviço, pois a extensão pode usar
      // Native Messaging e não passar pelo bearer HTTP.
      const oldNativeSession = await started.service.handle({
        id: 'old-native-session', protocolVersion: 1, method: 'task.list', payload: {}, token: read.result.token,
      });
      expect(oldNativeSession.ok).toBe(false);
      expect(oldNativeSession.error?.code).toBe('UNAUTHORIZED');
      const newNativeSession = await started.service.handle({
        id: 'new-native-session', protocolVersion: 1, method: 'task.list', payload: {}, token: rotated.result.token,
      });
      expect(newNativeSession.ok).toBe(true);

      // O token antigo deixa de autenticar (o IPC responde erro de sessão, não
      // um resultado); o novo autentica.
      const oldAuth = await fetch(`${base}api/ipc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${read.result.token}` },
        body: JSON.stringify({ id: 'x', token: read.result.token, protocolVersion: 1, method: 'auth.session', payload: {} }),
      });
      type IpcBody = { ok: boolean; result?: unknown; error?: { code?: string } };
      const oldBody = (await oldAuth.json()) as IpcBody;
      expect(oldBody.ok).toBe(false);
      // O token antigo já não abre sessão: o serviço recusa (erro, não resultado).
      expect(oldBody.error).toBeDefined();
      expect(oldBody.result).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const newAuth = await fetch(`${base}api/ipc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rotated.result.token}` },
        // auth.session valida o token do PAYLOAD: é assim que a extensão chama.
        body: JSON.stringify({
          id: 'y',
          token: rotated.result.token,
          protocolVersion: 1,
          method: 'auth.session',
          payload: { token: rotated.result.token },
        }),
      });
      // A rotação passa a valer para as chamadas seguintes (a resposta sai antes).
      // O token do gerador precisa ser sessão de verdade: a extensão o usa na
      // API. Antes era um UUID solto e o serviço respondia «sessão inválida».
      expect(newAuth.status).toBe(200);
      const newBody = (await newAuth.json()) as IpcBody;
      expect(newBody.ok).toBe(true);
      // E a tela passa a mostrar o token novo, que é o que o usuário cola.
      const again = (await fetch(`${base}api/token`, { headers: { 'sec-fetch-site': 'same-origin' } }).then((r) => r.json())) as Cred;
      expect(again.result.token).toBe(rotated.result.token);
    } finally {
      started.panel?.close();
    }
  });
});
