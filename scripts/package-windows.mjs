/**
 * Empacotador do Lord Marketplaces Analytics para Windows.
 *
 * O que ele produz em release/:
 *   LordMarketplacesAnalytics/
 *     runtime/node.exe        ← Node embutido (usuário não instala nada)
 *     app/                    ← código compilado do serviço local
 *     app/node_modules/       ← dependências de produção (sem toolchain)
 *     start.cmd               ← duplo clique abre o serviço e o painel
 *     README.txt
 *     extension/              ← extensão compilada (a que o Setup instala)
 *     tools/instalar-extensao.cmd
 *   LordMarketplacesAnalytics-<versao>.zip      ← pacote portátil
 *   Setup-LordMarketplacesAnalytics-<versao>.exe ← instalador (Inno Setup)
 *
 * Uso:  node scripts/package-windows.mjs            (portátil + Setup)
 *       node scripts/package-windows.mjs --sem-setup
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.6.0";
const OUT = join(ROOT, "release");
const APP = join(OUT, `LordMarketplacesAnalytics`);
const NODE_BIN = join(ROOT, "tools", "node-v22.14.0-win-x64", "node.exe");

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

/** tsc real do workspace (o .CMD não pode ser spawnado direto no Windows). */
/** Diretório real de um pacote dentro do store do pnpm. */
function findPackageDir(name) {
  const pnpm = join(ROOT, "node_modules", ".pnpm");
  if (!existsSync(pnpm)) return "";
  // Pacotes com escopo aparecem como @escopo+nome@versao no store.
  const flat = name.startsWith("@") ? name.replace("/", "+") : name;
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith(flat + "@")) continue;
    const candidate = join(pnpm, entry, "node_modules", name);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/** Localiza o binário JS do esbuild dentro do store do pnpm. */
function findEsbuild() {
  const candidates = [
    join(ROOT, "node_modules", ".pnpm", "node_modules", "esbuild", "bin", "esbuild"),
    join(ROOT, "apps", "extension", "node_modules", "esbuild", "bin", "esbuild"),
  ];
  const direct = candidates.find((c) => existsSync(c));
  if (direct) return direct;
  const pnpm = join(ROOT, "node_modules", ".pnpm");
  if (!existsSync(pnpm)) return "";
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith("esbuild@")) continue;
    const candidate = join(pnpm, entry, "node_modules", "esbuild", "bin", "esbuild");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function runTsc(project) {
  const candidates = [
    join(ROOT, "apps", "local-agent", "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "packages", "protocol", "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "node_modules", ".pnpm", "node_modules", "typescript", "bin", "tsc"),
  ];
  const bin = candidates.find((c) => existsSync(c));
  if (!bin) {
    console.error("\nFALTA: compilador TypeScript. Rode `pnpm install` na raiz.\n");
    process.exit(1);
  }
  execFileSync(process.execPath, [bin, "-p", project], { stdio: "inherit", cwd: ROOT });
}

function requireFile(path, hint) {
  if (!existsSync(path)) {
    console.error(`\nFALTA: ${path}\n${hint}\n`);
    process.exit(1);
  }
}

step("Conferindo pré-requisitos");
requireFile(NODE_BIN, "Baixe o Node portátil em tools/ ou aponte NODE_BIN para um node.exe existente.");

step("Limpando release anterior");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(APP, "app"), { recursive: true });
mkdirSync(join(APP, "runtime"), { recursive: true });
mkdirSync(join(APP, "tools"), { recursive: true });

step("Copiando runtime do Node");
copyFileSync(NODE_BIN, join(APP, "runtime", "node.exe"));

step("Compilando protocolo compartilhado");
runTsc(join("packages", "protocol", "tsconfig.build.json"));

step("Compilando o serviço local");
execFileSync(process.execPath, ["--version"], { stdio: "ignore" });
// tsx roda TypeScript direto; para produção compilamos com esbuild via tsx não é
// suficiente — usamos o tsc do workspace para gerar JS puro.
runTsc(join("apps", "local-agent", "tsconfig.build.json"));

step("Copiando aplicação");
cpSync(join(ROOT, "apps", "local-agent", "dist"), join(APP, "app"), { recursive: true });
copyFileSync(join(ROOT, "apps", "local-agent", "package.json"), join(APP, "app", "package.json"));

step("Empacotando as dependências do serviço");
// Copiar o store do pnpm inteiro traria o toolchain de build (5,6 GB). O certo é
// gerar um bundle com as dependências de runtime dentro: ~1 MB, sem symlink e
// sem precisar de node_modules no destino.
const esbuild = findEsbuild();
requireFile(esbuild, "esbuild não encontrado. Rode `pnpm install` na raiz.");
execFileSync(process.execPath, [
  esbuild,
  join(ROOT, "apps", "local-agent", "src", "main.ts"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--minify",
  "--external:jsdom",
  "--outfile=" + join(APP, "app", "main.bundle.mjs"),
  "--banner:js=import{createRequire as __cr}from\"node:module\";const require=__cr(import.meta.url);",
], { stdio: "inherit" });

step("Copiando jsdom e suas dependências (parser usado na captura)");
// jsdom é externo no bundle e carregado sob demanda. Ele tem dezenas de
// dependências transitivas, cada uma em seu próprio diretório do store: copiamos
// a lista completa, resolvida a partir do package.json de cada uma.
const copied = new Set();
function copyPackageWithDeps(name, depth = 0) {
  if (depth > 6 || copied.has(name)) return;
  copied.add(name);
  const src = findPackageDir(name);
  if (!src) {
    console.warn(`  aviso: dependência não encontrada no store: ${name}`);
    return;
  }
  const dest = join(APP, "app", "node_modules", name);
  if (!existsSync(dest)) cpSync(src, dest, { recursive: true, dereference: true });
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackageWithDeps(dep, depth + 1);
}
copyPackageWithDeps("jsdom");
console.log(`  ${copied.size} pacotes copiados`);

step("Copiando a extensão compilada");
const EXT_DIST = join(ROOT, "apps", "extension", "dist");
if (!existsSync(EXT_DIST)) {
  throw new Error("extensão não compilada: rode `pnpm --filter @lma/extension build` antes");
}
cpSync(EXT_DIST, join(APP, "extension"), { recursive: true });
console.log("  extension/ pronta");

step("Gerando start.cmd e README");
writeFileSync(
  join(APP, "start.cmd"),
  [
    "@echo off",
    "setlocal enableextensions enabledelayedexpansion",
    "title Lord Marketplaces Analytics",
    'set "HERE=%~dp0"',
    'set "LMA_DB_PATH=%LOCALAPPDATA%\\LordMarketplacesAnalytics\\data.db"',
    "rem O instalador grava o ID calculado da extensao em extension.json. Ler o",
    "rem arquivo em vez de pedir o ID ao usuario: o ID nao e secreto.",
    'set "LMA_EXTENSION_ORIGIN="',
    'if exist "%HERE%extension.json" (',
    '  set "LINE="',
    '  set /p LINE=<"%HERE%extension.json"',
    '  for /f "tokens=1,2" %%A in ("!LINE!") do set "QUOTED=%%B"',
    '  set ^"LMA_EXTENSION_ORIGIN=!QUOTED:~1,-2!^"',
    ")",
    'if "%LMA_EXTENSION_ORIGIN%"=="" (',
    "  echo.",
    '  echo  AVISO: nao encontrei extension.json. Rode o atalho "Instalar extensao no Chrome".',
    "  echo.",
    ")",
    'echo Iniciando o servico local...',
    '"%HERE%runtime\\node.exe" "%HERE%app\\main.bundle.mjs"',
    "pause",
  ].join("\r\n"),
  "utf8",
);

writeFileSync(
  join(APP, "README.txt"),
  [
    "Lord Marketplaces Analytics — pacote portátil",
    "",
    "1. Extraia esta pasta em qualquer lugar (ex.: C:\\LordMarketplacesAnalytics)",
    "2. Instale a extensão no Chrome/Edge (modo desenvolvedor) a partir da pasta extensao/",
    "3. Copie o ID que o navegador mostra para a extensão",
    "4. Abra start.cmd com duplo clique",
    "   — ele imprime um TOKEN DE PAREAMENTO",
    "5. No painel da extensão, cole o token e clique em Parear",
    "",
    "Nenhum dado sai deste computador. O banco fica em:",
    "  %LOCALAPPDATA%\\LordMarketplacesAnalytics\\data.db",
    "",
    "Este pacote não é um instalador: não escreve no registro, não pede admin.",
    "Para desinstalar, apague a pasta.",
    "",
    `Versão ${VERSION}`,
  ].join("\r\n"),
  "utf8",
);

step("Gerando instalar-extensao.cmd");
writeFileSync(
  join(APP, "tools", "instalar-extensao.cmd"),
  [
    "@echo off",
    "setlocal",
    'set "EXT=%~dp0..\\extension"',
    'echo.',
    'echo  Lord Marketplaces Analytics - instalar a extensao no Chrome/Edge',
    'echo.',
    'echo  Uma janela do navegador vai abrir na tela de extensoes.',
    'echo  1. Ative o "Modo do desenvolvedor" (canto superior direito).',
    'echo  2. Clique em "Carregar sem compactacao".',
    'echo  3. Escolha a pasta:',
    'echo      %EXT%',
    'echo.',
    'echo  O ID da extensao ja esta registrado no servico local -',
    'echo  nao e preciso copiar nada.',
    'echo.',
    "pause",
    'start "" chrome "chrome://extensions/" 2>nul || start "" msedge "edge://extensions/"',
    "endlocal",
  ].join("\r\n"),
  "utf8",
);

step("Compactando");
const zipPath = join(OUT, `LordMarketplacesAnalytics-${VERSION}.zip`);
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${APP}' -DestinationPath '${zipPath}' -Force`,
  ],
  { stdio: "inherit" },
);

const size = (statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`\n✓ Portátil: ${zipPath} (${size} MB)`);
console.log(`  Pasta: ${APP}`);

// ------------------------------------------------------------------ Setup.exe
const semSetup = process.argv.includes("--sem-setup");
const ISCC = join(ROOT, "tools", "inno", "setup", "ISCC.exe");

if (semSetup) {
  console.log("\n(instalador ignorado: --sem-setup)");
} else if (!existsSync(ISCC)) {
  console.log("\n⚠ Inno Setup não encontrado em tools/inno/setup — Setup.exe não gerado.");
  console.log("  Instale com:  winget download --id JRSoftware.InnoSetup --download-directory tools/inno");
  console.log("  e execute o .exe com /VERYSILENT /DIR=tools/inno/setup /CURRENTUSER");
  process.exitCode = 2;
} else {
  step("Gerando o instalador (Inno Setup)");
  const setupDir = join(OUT, "installer");
  mkdirSync(setupDir, { recursive: true });

  // O ID é derivado do caminho em que a extensão vai ficar na máquina do
  // usuário — aqui usamos o caminho padrão do instalador só para conferência.
  const defaultExtDir = "%LOCALAPPDATA%\\LordMarketplacesAnalytics\\extension";

  execFileSync(
    ISCC,
    [
      `/DAppVersion=${VERSION}`,
      `/DSourceDir=${APP}`,
      `/DOutputDir=${setupDir}`,
      join(ROOT, "installer", "setup.iss"),
    ],
    { stdio: "inherit", cwd: join(ROOT, "installer") },
  );

  const setupPath = join(setupDir, `Setup-LordMarketplacesAnalytics-${VERSION}.exe`);
  if (!existsSync(setupPath)) throw new Error("ISCC terminou sem gerar o Setup.exe");
  const setupSize = (statSync(setupPath).size / (1024 * 1024)).toFixed(1);
  console.log(`\n✓ Instalador: ${setupPath} (${setupSize} MB)`);
  console.log(`  Destino padrão: %LOCALAPPDATA%\\LordMarketplacesAnalytics`);
  console.log(`  Extensão: ${defaultExtDir}  (ID calculado na instalação)`);
}
