/**
 * Testes do canal loopback e do pareamento por token.
 *
 * Estes testes são a prova de segurança da POC: cada um falha se a proteção
 * correspondente for removida. Origem recusada, token inválido, token
 * reutilizado, token expirado, payload grande e protocolo incompatível.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, makeEnvelope, type HandshakeRequest } from "@lma/protocol";
import { LocalAgentServer } from "../src/loopback-server.js";

const ORIGIN_OK = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ORIGIN_BAD = "https://evil.example";

const servers: LocalAgentServer[] = [];
const sockets: WebSocket[] = [];

function createServer(overrides: Partial<Parameters<typeof LocalAgentServer.prototype.constructor>[0]> = {}) {
  const server = new LocalAgentServer({
    port: 0,
    allowedOrigins: [ORIGIN_OK],
    ...overrides,
  });
  servers.push(server);
  return server;
}

/**
 * Abre o socket e já começa a enfileirar mensagens: o servidor pode responder
 * antes de quem chamou pedir a próxima mensagem (pareamento acontece no "open").
 * Perder esse frame tornaria o teste instável, então a fila é criada aqui.
 */
const inbox = new WeakMap<WebSocket, unknown[]>();
const waiters = new WeakMap<WebSocket, ((v: unknown) => void)[]>();

function attachInbox(ws: WebSocket): void {
  const queue: unknown[] = [];
  inbox.set(ws, queue);
  waiters.set(ws, []);
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString());
    const waiting = waiters.get(ws);
    if (waiting && waiting.length > 0) {
      (waiting.shift() as (v: unknown) => void)(parsed);
    } else {
      queue.push(parsed);
    }
  });
}

function open(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    sockets.push(ws);
    attachInbox(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  const queue = inbox.get(ws) ?? [];
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout aguardando mensagem")), 3000);
    waiters.get(ws)?.push((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
  }
  for (const server of servers.splice(0)) await server.stop();
});

describe("canal loopback — escuta e origem", () => {
  it("escuta somente no loopback", async () => {
    const server = createServer();
    const { host } = await server.start();
    expect(host).toBe("127.0.0.1");
  });

  it("recusa origem fora da allowlist com ORIGIN_REJECTED", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_BAD);
    const msg = (await nextMessage(ws)) as { payload: { code: string } };
    expect(msg.payload.code).toBe("ORIGIN_REJECTED");
    expect(server.openSessions).toBe(0);
  });

  it("registra a recusa de origem na trilha de auditoria", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_BAD);
    await nextMessage(ws);
    const event = server.auditTrail.find((e) => e.detail.kind === "origin_rejected");
    expect(event).toBeDefined();
    expect(event?.kind).toBe("security");
  });
});

describe("pareamento por token", () => {
  it("aceita o token válido e devolve sessionId", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    const hs: HandshakeRequest = {
      token: server.pairingToken,
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    };
    ws.send(JSON.stringify(hs));
    const resp = (await nextMessage(ws)) as { accepted: boolean; sessionId?: string };
    expect(resp.accepted).toBe(true);
    expect(resp.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.openSessions).toBe(1);
  });

  it("recusa token inválido com AUTH_TOKEN_INVALID", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    ws.send(
      JSON.stringify({
        token: "a".repeat(32),
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const resp = (await nextMessage(ws)) as { accepted: boolean; error: { code: string } };
    expect(resp.accepted).toBe(false);
    expect(resp.error.code).toBe("AUTH_TOKEN_INVALID");
    expect(server.openSessions).toBe(0);
  });

  it("recusa o mesmo token uma segunda vez (uso único)", async () => {
    const server = createServer();
    const { port } = await server.start();
    const token = server.pairingToken;

    const first = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    first.send(JSON.stringify({ token, clientVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION }));
    expect(((await nextMessage(first)) as { accepted: boolean }).accepted).toBe(true);

    const second = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    second.send(JSON.stringify({ token, clientVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION }));
    const resp = (await nextMessage(second)) as { accepted: boolean; error: { code: string } };
    expect(resp.accepted).toBe(false);
    expect(resp.error.code).toBe("AUTH_TOKEN_INVALID");
  });

  it("recusa token expirado", async () => {
    let now = 1_000_000;
    const server = createServer({ now: () => now, tokenTtlMs: 1000 });
    const { port } = await server.start();
    const token = server.pairingToken;
    now += 5000;

    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    ws.send(JSON.stringify({ token, clientVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION }));
    const resp = (await nextMessage(ws)) as { accepted: boolean; error: { code: string } };
    expect(resp.accepted).toBe(false);
    expect(resp.error.code).toBe("AUTH_TOKEN_INVALID");
  });

  it("recusa protocolo incompatível antes de olhar o token", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    ws.send(
      JSON.stringify({
        token: server.pairingToken,
        clientVersion: "0.1.0",
        protocolVersion: "0.0.1",
      }),
    );
    const resp = (await nextMessage(ws)) as { accepted: boolean; error: { code: string } };
    expect(resp.accepted).toBe(false);
    expect(resp.error.code).toBe("PROTOCOL_VERSION_MISMATCH");
  });

  it("rotacionar o token invalida o anterior", async () => {
    const server = createServer();
    const { port } = await server.start();
    const old = server.pairingToken;
    server.rotateToken();

    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    ws.send(JSON.stringify({ token: old, clientVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION }));
    const resp = (await nextMessage(ws)) as { accepted: boolean };
    expect(resp.accepted).toBe(false);
  });
});

describe("mensagens de negócio após o pareamento", () => {
  async function paired() {
    const server = createServer();
    server.handle("system.ping", () => ({ action: "system.ping", pong: true }));
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    ws.send(
      JSON.stringify({
        token: server.pairingToken,
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await nextMessage(ws);
    return { server, ws };
  }

  it("não aceita mensagem de negócio antes do handshake", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_OK);
    ws.send(JSON.stringify(makeEnvelope("REQUEST", "system", { action: "system.ping" })));
    const resp = (await nextMessage(ws)) as { payload: { code: string } };
    expect(resp.payload.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("responde REQUEST com RESPONSE e o mesmo correlationId", async () => {
    const { ws } = await paired();
    const env = makeEnvelope("REQUEST", "system", { action: "system.ping" });
    ws.send(JSON.stringify(env));
    const resp = (await nextMessage(ws)) as {
      type: string;
      correlationId: string;
      payload: { pong: boolean };
    };
    expect(resp.type).toBe("RESPONSE");
    expect(resp.correlationId).toBe(env.correlationId);
    expect(resp.payload.pong).toBe(true);
  });

  it("devolve NOT_IMPLEMENTED para ação sem handler", async () => {
    const { ws } = await paired();
    ws.send(JSON.stringify(makeEnvelope("REQUEST", "system", { action: "system.nao_existe" })));
    const resp = (await nextMessage(ws)) as { type: string; payload: { code: string } };
    expect(resp.type).toBe("ERROR");
    expect(resp.payload.code).toBe("NOT_IMPLEMENTED");
  });

  it("recusa payload acima do limite do namespace", async () => {
    const { ws } = await paired();
    const huge = { action: "system.ping", blob: "x".repeat(70 * 1024) };
    ws.send(JSON.stringify(makeEnvelope("REQUEST", "system", huge)));
    const resp = (await nextMessage(ws)) as { payload: { code: string } };
    expect(resp.payload.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("fecha a conexão de origem proibida (código 1008)", async () => {
    const server = createServer();
    const { port } = await server.start();
    const ws = await open(`ws://127.0.0.1:${port}`, ORIGIN_BAD);
    const code = await closed(ws);
    expect(code).toBe(1008);
  });
});
