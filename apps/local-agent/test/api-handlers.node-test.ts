/**
 * Handlers `api.*` pelo canal real: o que o dashboard chama é o que se testa aqui.
 *
 * O que precisa valer, na ordem de importância:
 *  1. o segredo nunca volta na resposta;
 *  2. sem chave de cifra, a gravação é recusada (nunca texto puro);
 *  3. credencial recém-salva nasce NÃO verificada;
 *  4. o catálogo diz que a API é opcional e lista os campos de cada marketplace.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, makeEnvelope } from "@lma/protocol";
import { startAgent } from "../src/agent.js";
import { generateKeyBase64 } from "../src/services/api-credentials.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIGIN = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECRET = "APP_USR-segredo-que-nao-pode-vazar";

let dir: string;
let server: Awaited<ReturnType<typeof startAgent>>["server"];
let ctx: Awaited<ReturnType<typeof startAgent>>["ctx"];
let port: number;
let ws: WebSocket;
let replies: string[] = [];

/** Uma fila: cada chamada espera o próprio correlationId. */
const pending = new Map<string, (v: any) => void>();

function call(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = makeEnvelope("REQUEST", "api" as never, { action, ...payload });
    const timer = setTimeout(() => {
      pending.delete(env.correlationId);
      reject(new Error(`timeout em ${action}`));
    }, 5000);
    pending.set(env.correlationId, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    ws.send(JSON.stringify(env));
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "lma-api-"));
  const started = await startAgent({
    dbPath: join(dir, "test.db"),
    allowedOrigins: [ORIGIN],
    port: 0,
    env: { LMA_API_SECRET_KEY: generateKeyBase64() } as unknown as NodeJS.ProcessEnv,
  });
  server = started.server;
  ctx = started.ctx;
  port = started.port;

  ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  ws.on("message", (raw) => {
    const text = raw.toString();
    replies.push(text);
    const msg = JSON.parse(text);
    const waiter = pending.get(msg.correlationId);
    if (!waiter) return;
    pending.delete(msg.correlationId);
    waiter(msg.type === "ERROR" ? { __error: msg.payload } : msg.payload);
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  await new Promise<void>((resolve, reject) => {
    ws.once("message", (raw) => {
      const hs = JSON.parse(raw.toString());
      if (hs.accepted) resolve();
      else reject(new Error(`handshake recusado: ${JSON.stringify(hs)}`));
    });
    ws.send(JSON.stringify({ token: server.pairingToken, clientVersion: "0.5.0", protocolVersion: PROTOCOL_VERSION }));
  });
});

after(async () => {
  ws?.terminate();
  await server?.stop();
  ctx?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("catálogo de conectores", () => {
  test("lista os cinco marketplaces com campos e documentação", async () => {
    const r = await call("api.catalog");
    assert.ok(Array.isArray(r.connectors));
    const ids = r.connectors.map((c: any) => c.marketplace).sort();
    assert.deepEqual(ids, ["amazon", "mercadolivre", "shein", "shopee", "tiktokshop"]);
    for (const c of r.connectors) {
      assert.ok(c.name.length > 0, `${c.marketplace} sem nome`);
      assert.ok(c.docsUrl.startsWith("https://"), `${c.marketplace} sem docs`);
      assert.ok(c.fields.length >= 2, `${c.marketplace} com poucos campos`);
      assert.ok(c.fields.some((f: any) => f.secret), `${c.marketplace} sem campo secreto`);
    }
    assert.equal(r.encryptionAvailable, true);
  });
});

describe("gravação de credencial", () => {
  test("nasce sem verificação e sem devolver o segredo", async () => {
    const saved = await call("api.save", {
      marketplace: "mercadolivre",
      label: "Loja teste",
      accountRef: "123",
      publicFields: { app_id: "999" },
      secret: SECRET,
    });
    assert.equal(saved.credential.status, "PENDING");
    assert.equal(saved.credential.hasSecret, true);
    assert.equal(saved.credential.lastVerifiedAt, null);

    const list = await call("api.list");
    assert.equal(list.credentials.length, 1);
    assert.equal(list.credentials[0].status, "PENDING");
    assert.equal(list.credentials[0].publicFields.app_id, "999");

    // O segredo não pode aparecer em nenhuma resposta do canal.
    const all = replies.join("\n");
    assert.equal(all.includes(SECRET), false, "segredo vazou na resposta");
    // E não pode estar em texto puro no banco.
    const rows = ctx.db.raw().prepare("SELECT secret_cipher, secret_iv, secret_tag FROM api_credentials").all();
    assert.equal(JSON.stringify(rows).includes(SECRET), false, "segredo em texto puro no banco");
  });

  test("recusa marketplace desconhecido", async () => {
    const r = await call("api.save", {
      marketplace: "aliexpress",
      label: "x",
      publicFields: {},
      secret: "abc12345",
    });
    assert.ok(r.__error, "deveria recusar");
    assert.ok(["VALIDATION_FAILED", "SCHEMA_VALIDATION_FAILED"].includes(r.__error.code));
  });

  test("recusa segredo curto", async () => {
    const r = await call("api.save", {
      marketplace: "shopee",
      label: "x",
      publicFields: { partner_id: "1" },
      secret: "curto",
    });
    assert.ok(r.__error);
    assert.ok(["VALIDATION_FAILED", "SCHEMA_VALIDATION_FAILED"].includes(r.__error.code));
  });

  test("remoção de id inexistente responde CREDENTIAL_NOT_FOUND", async () => {
    const r = await call("api.remove", { id: "00000000-0000-0000-0000-000000000000" });
    assert.ok(r.__error);
    assert.equal(r.__error.code, "CREDENTIAL_NOT_FOUND");
  });

  test("remove a credencial existente", async () => {
    const list = await call("api.list");
    const id = list.credentials[0].id;
    const removed = await call("api.remove", { id });
    assert.equal(removed.removed, true);
    const after = await call("api.list");
    assert.equal(after.credentials.length, 0);
  });
});

describe("serviço sem chave de cifra", () => {
  test("recusa gravar em vez de cair para texto puro", async () => {
    // Serviço novo, sem LMA_API_SECRET_KEY no ambiente.
    const dir2 = mkdtempSync(join(tmpdir(), "lma-nokey-"));
    const started = await startAgent({
      dbPath: join(dir2, "test.db"),
      allowedOrigins: [ORIGIN],
      port: 0,
      env: {} as unknown as NodeJS.ProcessEnv,
    });
    const ws2 = new WebSocket(`ws://127.0.0.1:${started.port}`, { origin: ORIGIN });
    const queue = new Map<string, (v: any) => void>();
    ws2.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = queue.get(msg.correlationId);
      if (w) {
        queue.delete(msg.correlationId);
        w(msg.type === "ERROR" ? { __error: msg.payload } : msg.payload);
      }
    });
    await new Promise<void>((r) => ws2.once("open", () => r()));
    await new Promise<void>((resolve) => {
      ws2.once("message", () => resolve());
      ws2.send(JSON.stringify({ token: started.server.pairingToken, clientVersion: "0.5.0", protocolVersion: PROTOCOL_VERSION }));
    });
    const send = (action: string, payload: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        const env = makeEnvelope("REQUEST", "api" as never, { action, ...payload });
        queue.set(env.correlationId, resolve);
        ws2.send(JSON.stringify(env));
      });

    const cat = await send("api.catalog");
    assert.equal(cat.encryptionAvailable, false);
    const r = await send("api.save", {
      marketplace: "mercadolivre",
      label: "x",
      publicFields: { app_id: "1" },
      secret: "segredo-bem-longo-123",
    });
    assert.ok(r.__error, "deveria recusar sem chave");
    assert.equal(r.__error.code, "ENCRYPTION_KEY_MISSING");
    const rows = started.ctx.db.raw().prepare("SELECT COUNT(*) AS n FROM api_credentials").get() as { n: number };
    assert.equal(rows.n, 0, "nada pode ter sido gravado");

    ws2.terminate();
    await started.server.stop();
    started.ctx.db.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});
