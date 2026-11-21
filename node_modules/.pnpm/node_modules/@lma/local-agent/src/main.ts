/**
 * Entrada do serviço local.
 *
 * Arranque: gera/reaproveita o token de pareamento, abre o canal loopback,
 * registra os handlers do namespace system e imprime o token no console local
 * (é assim que o usuário pareia a extensão na POC).
 *
 * Nada aqui abre porta fora do loopback nem exige administrador.
 */
import { DEFAULT_HOST, DEFAULT_PORT, LocalAgentServer } from "./loopback-server.js";

const port = Number(process.env.LMA_PORT ?? DEFAULT_PORT);
const host = process.env.LMA_HOST ?? DEFAULT_HOST;

/**
 * Origens aceitas. Na POC a extensão é carregada sem empacotamento e o ID
 * varia; o ID real aparece em chrome://extensions e deve ser colado aqui
 * (ou em LMA_EXTENSION_ORIGIN). Sem allowlist, o serviço recusa tudo —
 * isso é proposital.
 */
const allowedOrigins = (process.env.LMA_EXTENSION_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const server = new LocalAgentServer({ port, host, allowedOrigins });

server.handle("system.ping", () => ({
  action: "system.ping",
  pong: true,
  serverVersion: "0.1.0",
  uptimeSeconds: Math.round(process.uptime()),
}));

server.handle("system.health", () => ({
  action: "system.health",
  sessions: server.openSessions,
  auditEvents: server.auditTrail.length,
  paired: server.openSessions > 0,
}));

const started = await server.start();

console.log("──────────────────────────────────────────────");
console.log(" Lord Marketplaces Analytics — Serviço local");
console.log(` canal:  ws://${started.host}:${started.port}`);
console.log(` token:  ${server.pairingToken}`);
console.log(` expira: em 10 minutos ou no primeiro uso`);
if (allowedOrigins.length === 0) {
  console.log(" origens aceitas: NENHUMA (defina LMA_EXTENSION_ORIGIN)");
} else {
  console.log(` origens aceitas: ${allowedOrigins.join(", ")}`);
}
console.log("──────────────────────────────────────────────");

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
