import { existsSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export function parsePort(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 65535 ? n : null;
}

export async function readyUrl(port, mode = 'panel', request = fetch) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const base = 'http://127.0.0.1:' + port;
  try {
    const response = await request(base + '/api/health', {
      redirect: 'error', signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body.ok !== true || body.protocolVersion !== 1 ||
        typeof body.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(body.version)) return null;
    return base + (mode === 'prestart' ? '/prestart' : '/');
  } catch { return null; }
}

function readPort(data) {
  try { return parsePort(readFileSync(join(data, 'port.txt'), 'utf8')); }
  catch { return null; }
}

async function openPanel(url, mode) {
  if (mode === 'background') return;
  // URL criada exclusivamente com endereço loopback, porta numérica e caminho fixo.
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/(?:prestart)?$/.test(url)) throw Error('URL local inválida');
  const browser = spawn('cmd.exe', ['/d', '/c', 'start "" ' + url], {
    windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore'
  });
  await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', code => code === 0 ? resolve() : reject(Error('Não foi possível abrir o navegador'))); });
}

export async function launch(mode, root, data) {
  if (!['panel', 'prestart', 'background'].includes(mode)) throw Error('Modo de inicialização inválido');
  mkdirSync(join(data, 'logs'), { recursive: true });
  const marker = join(data, 'update-in-progress.json');
  if (existsSync(marker)) throw Error('Atualização em andamento; inicialização bloqueada');
  const existing = await readyUrl(readPort(data), mode);
  if (existing) { await openPanel(existing, mode); return; }
  const preferredPort = readPort(data) ?? 47811;
  let stdout, stderr, service;
  try {
    stdout = openSync(join(data, 'logs', 'service.log'), 'a');
    stderr = openSync(join(data, 'logs', 'service-err.log'), 'a');
    service = spawn(join(root, 'node.exe'), [join(root, 'local-agent', 'main.js'), '--serve', '--port=' + preferredPort, '--data=' + data], {
      detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr]
    });
  } finally {
    if (stdout !== undefined) closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
  let failed = false;
  service.on('error', () => { failed = true; });
  service.on('exit', () => { failed = true; });
  service.unref();
  for (let i = 0; i < 60; i++) {
    if (existsSync(marker)) throw Error('Atualização em andamento; inicialização bloqueada');
    const url = await readyUrl(readPort(data), mode);
    if (url) { await openPanel(url, mode); return; }
    if (failed) break;
    await sleep(500);
  }
  throw Error('O serviço local não respondeu ao health check. Consulte os logs no diretório de dados.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = ({ '': 'panel', '--prestart': 'prestart', '--background': 'background' })[process.argv[2] ?? ''];
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || !mode) {
    console.error('Inicialização exige Windows, LOCALAPPDATA e modo válido.');
    process.exitCode = 1;
  } else {
    try { await launch(mode, dirname(fileURLToPath(import.meta.url)), join(process.env.LOCALAPPDATA, 'MarketplaceIntelligence')); }
    catch (err) { console.error(err instanceof Error ? err.message : 'Falha de inicialização'); process.exitCode = 1; }
  }
}
