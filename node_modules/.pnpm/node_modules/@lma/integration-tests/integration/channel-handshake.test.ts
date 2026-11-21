/**
 * Teste de integração real: extensão (cliente do canal) ↔ serviço local.
 *
 * Não simula o protocolo: sobe o LocalAgentServer de verdade, conecta com o
 * mesmo conjunto de regras do cliente, pareia com token e faz um ping. Serve
 * como prova de que os dois lados falam o mesmo contrato.
 *
 * O WebSocket aqui é o `ws` do Node; o navegador usa a mesma API padrão.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, makeEnvelope } from "@lma/protocol";
import { LocalAgentServer } from "@lma/local-agent/loopback";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const servers: LocalAgentServer[] = [];
const sockets: WebSocket[] = [];

function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 3000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) await s.stop();
});

describe("integração extensão ↔ serviço local", () => {
  it("pareia com o token e recebe pong do serviço local", async () => {
    const server = new LocalAgentServer({ port: 0, allowedOrigins: [ORIGIN] });
    server.handle("system.ping", () => ({ pong: true, serverVersion: "0.1.0" }));
    const { port } = await server.start();
    servers.push(server);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    // 1. handshake, exatamente como o channel.ts da extensão faz
    ws.send(
      JSON.stringify({
        token: server.pairingToken,
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const hs = await next(ws);
    expect(hs.accepted).toBe(true);
    expect(hs.sessionId).toBeTruthy();

    // 2. requisição de negócio
    const env = makeEnvelope("REQUEST", "system", { action: "system.ping" });
    ws.send(JSON.stringify(env));
    const resp = await next(ws);
    expect(resp.type).toBe("RESPONSE");
    expect(resp.correlationId).toBe(env.correlationId);
    expect(resp.payload.pong).toBe(true);
  });

  it("o serviço recusa a extensão que não pareou", async () => {
    const server = new LocalAgentServer({ port: 0, allowedOrigins: [ORIGIN] });
    const { port } = await server.start();
    servers.push(server);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify(makeEnvelope("REQUEST", "system", { action: "system.ping" })));
    const resp = await next(ws);
    expect(resp.payload.code).toBe("SCHEMA_VALIDATION_FAILED");
  });
});
