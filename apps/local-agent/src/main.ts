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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { generateKeyBase64 } from "./services/api-credentials.js";

/**
 * Abre uma URL no navegador padrão do Windows.
 *
 * `start` e comando interno do cmd.exe: sem o titulo vazio ("") antes da URL,
 * o cmd toma a URL como titulo da janela e nao abre nada.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return;
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Sem navegador nao e erro: a URL ja foi impressa no console.
  }
}

function defaultDbPath(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "LordMarketplacesAnalytics", "data.db");
}

/** Pasta de configuração do produto (ao lado do banco). */
function configDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "LordMarketplacesAnalytics");
}

/**
 * Lê o ID da extensão gravado pelo instalador.
 *
 * Por que isto existe: o ID de uma extensão carregada fora da Chrome Web Store
 * é derivado do caminho da pasta — muda de computador para computador. O
 * instalador gera o ID da pasta que ele mesmo criou e grava aqui; o serviço
 * então já sabe qual origem aceitar sem o usuário copiar nada.
 */
function readInstalledOrigin(): string | null {
  try {
    const raw = readFileSync(join(configDir(), "extension.json"), "utf8");
    const parsed = JSON.parse(raw) as { origin?: string };
    const origin = parsed.origin?.trim();
    return origin && origin.startsWith("chrome-extension://") ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Chave de criptografia das credenciais de API.
 *
 * Prioridade: variável de ambiente (para quem quer controlar a chave) e, senão,
 * um arquivo local na pasta de configuração — gerado na primeira execução e
 * mostrado no painel de status. Sem chave, o serviço recusa gravar segredo em
 * vez de cair para texto puro.
 */
function ensureApiKey(): string | null {
  const fromEnv = process.env.LMA_API_SECRET_KEY?.trim();
  if (fromEnv) return fromEnv;

  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "api-key.txt");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* ainda não existe: gera abaixo */
  }
  const generated = generateKeyBase64();
  writeFileSync(file, generated, { encoding: "utf8", mode: 0o600 });
  console.log(` chave:  gerada em ${file} (guarde: é ela que abre as credenciais de API)`);
  return generated;
}

async function main(): Promise<void> {
  const apiKey = ensureApiKey();
  if (apiKey && !process.env.LMA_API_SECRET_KEY) process.env.LMA_API_SECRET_KEY = apiKey;

  const fromEnv = (process.env.LMA_EXTENSION_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const installed = fromEnv.length === 0 ? readInstalledOrigin() : null;
  const origins = installed ? [installed] : fromEnv;

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
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    join(configDir(), "runtime.json"),
    JSON.stringify({ port, startedAt: new Date().toISOString(), pid: process.pid }, null, 2),
    "utf8",
  );
  console.log(` banco:  ${dbPath}`);
  console.log(` canal:  ws://${DEFAULT_HOST}:${port}`);
  if (origins.length === 0) {
    console.log(" origem: NENHUMA configurada — conexões serão recusadas.");
    console.log("         rode com LMA_EXTENSION_ORIGIN=chrome-extension://<ID>");
    console.log("         ou abra pelo atalho do menu Iniciar (o instalador grava o ID).");
  } else {
    console.log(` origem: ${origins.join(", ")}${installed ? " (lida do instalador)" : ""}`);
  }
  console.log(` gemini: ${ctx.gemini.isConfigured() ? "configurado" : "não configurado (produto funciona sem ele)"}`);
  console.log(` dono:   ${ctx.ownerId}`);
  console.log(line);
  writeFileSync(
    join(configDir(), "pairing.json"),
    JSON.stringify({ token: server.pairingToken, issuedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  console.log(` TOKEN DE PAREAMENTO: ${server.pairingToken}`);
  console.log(" uso único, expira em 10 minutos. Cole no painel da extensão.");
  console.log(line);

  /**
   * Painel de status local (http://127.0.0.1:<porta>/).
   *
   * Existe porque o token de pareamento expira em 10 minutos e o usuário não
   * deve precisar reabrir um terminal: aqui ele vê o estado e pede um token
   * novo. Só 127.0.0.1, sem CORS, sem escrita de dado de marketplace.
   */
  const statusPort = port + 1;
  const statusServer = createServer((req, res) => {
    if (req.url === "/token" && req.method === "POST") {
      const fresh = server.rotateToken();
      writeFileSync(
        join(configDir(), "pairing.json"),
        JSON.stringify({ token: fresh, issuedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: fresh }));
      return;
    }
    const state = {
      version: AGENT_VERSION,
      port,
      dbPath,
      origin: origins[0] ?? null,
      gemini: ctx.gemini.isConfigured(),
      api: `${ctx.credentials.list().length} credencial(is) de API · ${
        ctx.credentials.encryptionAvailable ? "criptografia ativa" : "sem chave"
      }`,
      owner: ctx.ownerId,
    };
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Lord Marketplaces Analytics — serviço local</title>
<style>
 body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8eb;margin:0;padding:40px}
 main{max-width:640px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8b949e;font-size:13px;margin-bottom:28px}
 dl{display:grid;grid-template-columns:140px 1fr;gap:10px 16px;font-size:14px}
 dt{color:#8b949e}dd{margin:0;font-family:ui-monospace,monospace}
 .ok{color:#3fb950}.off{color:#d29922}
 button{margin-top:28px;background:#2f81f7;color:#fff;border:0;padding:10px 18px;border-radius:6px;font-size:14px;cursor:pointer}
 #tok{margin-top:14px;font-family:ui-monospace,monospace;background:#161b22;padding:12px;border-radius:6px;word-break:break-all;font-size:13px;display:none}
 .cta{display:block;margin-top:32px;padding:16px 18px;border:1px solid #2f81f7;background:#101a2b;border-radius:8px}
 .cta h2{font-size:15px;margin:0 0 6px}
 .cta p{color:#8b949e;font-size:13px;margin:0 0 12px;line-height:1.5}
 .cta ol{color:#c9d1d9;font-size:13px;margin:0;padding-left:18px;line-height:1.7}
</style></head><body><main>
<h1>Lord Marketplaces Analytics</h1>
<div class="sub">serviço local v${state.version} — só este computador</div>
<dl>
 <dt>Endereço</dt><dd>ws://127.0.0.1:${port}</dd>
 <dt>Banco</dt><dd>${dbPath}</dd>
 <dt>Extensão</dt><dd class="${state.origin ? "ok" : "off"}">${state.origin ?? "não configurada"}</dd>
 <dt>Gemini</dt><dd class="${state.gemini ? "ok" : "off"}">${state.gemini ? "configurado" : "opcional, não configurado"}</dd>
 <dt>Proprietário</dt><dd>${state.owner}</dd>
 <dt>API</dt><dd class="${state.api.includes("criptografia ativa") ? "ok" : "off"}">${state.api}</dd>
</dl>
<button onclick="novoToken()">Gerar novo token de pareamento</button>
<div id="tok"></div>

<div class="cta">
  <h2>É aqui que se abre o painel</h2>
  <p>Este serviço não tem tela própria: quem mostra os anúncios, os pedidos e as APIs é a extensão instalada no Chrome ou no Edge.</p>
  <ol>
    <li>No Chrome, abra <b>chrome://extensions</b> e confirme que "Lord Marketplaces Analytics" está na lista (ligada).</li>
    <li>Clique no icone da extensao na barra do navegador.</li>
    <li>Cole o token acima e clique em Parear.</li>
    <li>O dashboard abre em aba inteira. Depois disso, ele fica no menu da extensão.</li>
  </ol>
</div>
<script>
async function novoToken(){
  const r = await fetch('/token', {method:'POST'});
  const d = await r.json();
  const el = document.getElementById('tok');
  el.style.display = 'block';
  el.textContent = 'Cole no painel da extensão: ' + d.token;
}
</script>
</main></body></html>`);
  });
  statusServer.listen(statusPort, DEFAULT_HOST);
  const statusUrl = `http://${DEFAULT_HOST}:${statusPort}/`;
  console.log(` status: ${statusUrl}  (ver estado e gerar novo token)`);

  // Abrir o navegador no painel não é enfeite: o atalho do instalador é o
  // serviço, e uma janela preta sozinha não leva a lugar nenhum. O painel é a
  // porta de entrada — dele sai o token e o botão para abrir o dashboard.
  if (process.env.LMA_NO_BROWSER !== "1") {
    openBrowser(statusUrl);
  }

  const shutdown = async () => {
    console.log("\nEncerrando…");
    ctx.audit.append("shutdown", {});
    statusServer.close();
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
