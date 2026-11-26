/**
 * Gera o instalador Windows completo.
 *
 * Pré-requisitos (verificados antes de compilar):
 *  - Inno Setup 6 (ISCC.exe)
 *  - dist/ gerado pelos scripts de build
 *  - tools/node.exe (runtime embarcado)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const CANDIDATES = [
  process.env.ISCC_PATH,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
].filter(Boolean);

const iscc = CANDIDATES.find((p) => existsSync(p));
if (!iscc) {
  console.error('ERRO: ISCC.exe (Inno Setup 6) não encontrado. Instale com: winget install JRSoftware.InnoSetup');
  process.exit(1);
}

const nodeExe = join(root, 'tools', 'node.exe');
if (!existsSync(nodeExe)) {
  mkdirSync(join(root, 'tools'), { recursive: true });
  // process.execPath nem sempre é o binário (shims); o Node portátil está em ../tools.
  const portable = join(root, '..', 'tools', 'node-v22.14.0-win-x64', 'node.exe');
  const source = existsSync(portable) ? portable : process.execPath;
  copyFileSync(source, nodeExe);
  console.log(`node.exe embarcado a partir de ${source}`);
}

/** ID do Chrome a partir da chave pública (sha256 do DER, primeiros 32 nibbles → a-p). */
function deriveExtensionId(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.key) return '';
  const der = Buffer.from(manifest.key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex');
  let id = '';
  for (let i = 0; i < 32; i += 1) id += String.fromCharCode(97 + parseInt(hex[i], 16));
  return id;
}

for (const required of ['dist/local-agent/main.js', 'dist/native-host/native-host.js', 'dist/native-host/register.js', 'dist/extension/manifest.json']) {
  if (!existsSync(join(root, required))) {
    console.error(`ERRO: artefato ausente: ${required}. Rode npm run agent:build host:build ext:build antes.`);
    process.exit(1);
  }
}

// O ID da extensão é fixo: vem da chave pública gravada no manifest. Assim o
// host nativo pode ser registrado antes de o usuário carregar a extensão.
const extensionId = process.env.MI_EXTENSION_ID ?? deriveExtensionId(join(root, 'dist', 'extension', 'manifest.json'));
const args = [
  join(root, 'installer', 'marketplace-intelligence.iss'),
  `/DAppVersion=${pkg.version}`,
  `/DSourceRoot=${root}`,
  ...(extensionId ? [`/DExtensionId=${extensionId}`] : []),
  '/Qp',
];

console.log(`Compilando instalador com ${iscc}`);
const result = spawnSync(iscc, args, { stdio: 'inherit', cwd: root });
if (result.status !== 0) {
  console.error(`ERRO: ISCC terminou com código ${result.status}`);
  process.exit(result.status ?? 1);
}

const setup = join(root, 'installer', 'output', 'MarketplaceIntelligence-Setup.exe');
if (!existsSync(setup)) {
  console.error('ERRO: instalador não foi gerado');
  process.exit(1);
}
mkdirSync(join(root, 'dist'), { recursive: true });
console.log(`OK  ${setup}`);
