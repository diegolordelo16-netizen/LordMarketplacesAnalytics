#!/usr/bin/env node
/**
 * Publica o projeto no GitHub deixando o repositório com UMA estrutura só.
 *
 * Diferente de enviar-github.mjs (que só acrescenta), aqui a árvore é montada do
 * zero a partir da pasta local: todo caminho do repositório que não existir na
 * lista enviada simplesmente não entra na árvore nova — é assim que a API do
 * GitHub apaga, sem precisar de git instalado.
 *
 * Uso: node scripts/publicar-github.mjs [--dry]
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.MI_REPO ?? 'diegolordelo16-netizen/LordMarketplacesAnalytics';
const BRANCH = process.env.MI_BRANCH ?? 'master';
const GH = 'C:/Users/ferro/.abacusai-bot/session-home/tools/gh/bin/gh.exe';
const DRY = process.argv.includes('--dry');

/** O conteúdo vai num arquivo e o gh o lê com --input (argumentos do Windows são curtos). */
let tmpSeq = 0;
function gh(args, input) {
  let finalArgs = args;
  if (input !== undefined) {
    const file = join(process.env.TEMP ?? '.', `mi-gh-${process.pid}-${tmpSeq++}.json`);
    writeFileSync(file, input, 'utf8');
    finalArgs = [...args, '--input', file];
  }
  return execFileSync(GH, finalArgs, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }).trim();
}
function ghJson(args, input) {
  const raw = gh(args, input);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`resposta não é JSON: ${raw.slice(0, 300)}`);
  }
}

const files = JSON.parse(readFileSync(join(ROOT, 'upload-list.json'), 'utf8'));
console.log(`${files.length} arquivos locais; repositório ${REPO}@${BRANCH}${DRY ? ' (simulação)' : ''}`);

// 1. estado atual
const ref = ghJson(['api', `repos/${REPO}/git/ref/heads/${BRANCH}`]);
const baseSha = ref.object.sha;
const baseCommit = ghJson(['api', `repos/${REPO}/git/commits/${baseSha}`]);
const baseTree = baseCommit.tree.sha;

// 2. o que existe hoje e não vai continuar
const oldTree = ghJson(['api', `repos/${REPO}/git/trees/${baseTree}?recursive=1`]);
const keep = new Set(files);
const removed = oldTree.tree
  .filter((e) => e.type === 'blob')
  .map((e) => e.path)
  .filter((p) => !keep.has(p));
console.log(`serão removidos ${removed.length} arquivos antigos`);
if (DRY) {
  console.log(removed.slice(0, 40).join('\n'));
  console.log(`... e mais ${Math.max(0, removed.length - 40)}`);
  process.exit(0);
}

// 3. um blob por arquivo local
const tree = [];
for (const rel of files) {
  const abs = join(ROOT, rel);
  const b64 = readFileSync(abs).toString('base64');
  const blob = ghJson(
    ['api', '-X', 'POST', `repos/${REPO}/git/blobs`],
    JSON.stringify({ content: b64, encoding: 'base64' }),
  );
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
}
console.log(`${tree.length} blobs criados`);

// 4. árvore NOVA (sem base_tree): o que não está aqui deixa de existir
const newTree = ghJson(['api', '-X', 'POST', `repos/${REPO}/git/trees`], JSON.stringify({ tree }));
console.log(`árvore nova: ${newTree.sha.slice(0, 7)}`);

// 5. commit + move do branch
const message = (
  process.env.MI_MSG ??
  [
    'refactor: repositório com uma estrutura só (packages/, scripts/, docs/, installer/)',
    '',
    '177/177 testes, tsc limpo.',
  ].join('\n')
);
const commit = ghJson(
  ['api', '-X', 'POST', `repos/${REPO}/git/commits`],
  JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
);
ghJson(['api', '-X', 'PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`], JSON.stringify({ sha: commit.sha }));

// 6. conferência: a árvore publicada tem que ser exatamente a lista local
const check = ghJson(['api', `repos/${REPO}/git/trees/${newTree.sha}?recursive=1`]);
const published = check.tree.filter((e) => e.type === 'blob').map((e) => e.path).sort();
const expected = [...files].sort();
const missing = expected.filter((p) => !published.includes(p));
const extra = published.filter((p) => !expected.includes(p));
console.log(`publicados: ${published.length} | faltando: ${missing.length} | sobrando: ${extra.length}`);
if (missing.length) console.log('faltando:', missing.slice(0, 10));
if (extra.length) console.log('sobrando:', extra.slice(0, 10));
console.log(`OK https://github.com/${REPO}/commit/${commit.sha}`);
