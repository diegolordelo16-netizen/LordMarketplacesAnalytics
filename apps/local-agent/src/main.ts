#!/usr/bin/env node
/**
 * Ponto de entrada do serviço local do Lord Marketplaces Analytics.
 *
 * O que ele faz ao subir:
 *  1. abre (ou cria) o banco em %LOCALAPPDATA%\LordMarketplacesAnalytics\data.db;
 *  2. escuta APENAS em 127.0.0.1 na porta 47821;
 *  3. imprime o token de pareamento para o usuário colar na extensão;
 *  4. registra todos os handlers de negócio.
 *
 * Sem extensão configurada ele não aceita conexão nenhuma — por projeto.
 */
import { DEFAULT_PORT, DEFAULT_HOST } from "./loopback-server.js";
import { startAgent, AGENT_VERSION } from "./agent.js";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultDbPath(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "LordMarketplacesAnalytics", "data.db");
}

async function main(): Promise<void> {
  const origins = (process.env.LMA_EXTENSION_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const dbPath = process.env.LMA_DB_PATH ?? defaultDbPath();
  const port = Number(process.env.LMA_PORT ?? DEFAULT_PORT);

  const { server, ctx } = await startAgent({
    dbPath,
    allowedOrigins: origins,
    port,
  });

  const line = "─".repeat(64);
  console.log(line);
  console.log(` Lord Marketplaces Analytics — serviço local v${AGENT_VERSION}`);
  console.log(line);
  console.log(` banco:  ${dbPath}`);
  console.log(` canal:  ws://${DEFAULT_HOST}:${port}`);
  if (origins.length === 0) {
    console.log(" origem: NENHUMA configurada — conexões serão recusadas.");
    console.log("         rode com LMA_EXTENSION_ORIGIN=chrome-extension://<ID>");
  } else {
    console.log(` origem: ${origins.join(", ")}`);
  }
  console.log(` gemini: ${ctx.gemini.isConfigured() ? "configurado" : "não configurado (produto funciona sem ele)"}`);
  console.log(` dono:   ${ctx.ownerId}`);
  console.log(line);
  console.log(` TOKEN DE PAREAMENTO: ${server.pairingToken}`);
  console.log(" uso único, expira em 10 minutos. Cole no painel da extensão.");
  console.log(line);

  const shutdown = async () => {
    console.log("\nEncerrando…");
    ctx.audit.append("shutdown", {});
    await server.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Falha ao iniciar o serviço local:", err);
  process.exit(1);
});
