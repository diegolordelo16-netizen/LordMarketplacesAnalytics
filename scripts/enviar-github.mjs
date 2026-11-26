#!/usr/bin/env node
/**
 * Envia o projeto para o GitHub pela API (sem git instalado na máquina).
 *
 * Estratégia:
 *   - lê upload-list.json (arquivos a enviar, relativo à raiz do projeto);
 *   - cria um blob por arquivo (a API aceita até ~50 MB por blob);
 *   - monta UMA árvore nova com base na árvore atual do branch master;
 *   - cria um commit único e move o ref do branch.
 *
 * Nada é apagado: os caminhos antigos do repositório continuam na árvore.
 * Uso: node scripts/enviar-github.mjs
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'diegolordelo16-netizen/LordMarketplacesAnalytics';
const BRANCH = 'master';
const GH = 'C:/Users/ferro/.abacusai-bot/session-home/tools/gh/bin/gh.exe';

/**
 * O conteúdo vai num arquivo e o gh o lê com --input: passar base64 pela linha
 * de comando estoura o limite de argumentos do Windows (ENAMETOOLONG).
 */
let tmpSeq = 0;
function gh(args, input) {
  let finalArgs = args;
  if (input !== undefined) {
    const file = join(process.env.TEMP ?? '.', `mi-gh-${process.pid}-${tmpSeq++}.json`);
    writeFileSync(file, input, 'utf8');
    finalArgs = [...args, '--input', file];
  }
  const out = execFileSync(GH, finalArgs, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return out.trim();
}

function ghJson(args, input) {
  const raw = gh(args, input);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`resposta não é JSON: ${raw.slice(0, 200)}`);
  }
}

const files = JSON.parse(readFileSync(join(ROOT, 'upload-list.json'), 'utf8'));
console.log(`${files.length} arquivos a enviar`);

// 1. estado atual do branch
const ref = ghJson(['api', `repos/${REPO}/git/ref/heads/${BRANCH}`]);
const baseSha = ref.object.sha;
const baseCommit = ghJson(['api', `repos/${REPO}/git/commits/${baseSha}`]);
const baseTree = baseCommit.tree.sha;
console.log(`base: ${baseSha.slice(0, 7)} (árvore ${baseTree.slice(0, 7)})`);

// 2. um blob por arquivo
const tree = [];
for (const rel of files) {
  const abs = join(ROOT, rel);
  const size = statSync(abs).size;
  const b64 = readFileSync(abs).toString('base64');
  const blob = ghJson(
    ['api', '-X', 'POST', `repos/${REPO}/git/blobs`],
    JSON.stringify({ content: b64, encoding: 'base64' }),
  );
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  ${(size / 1024).toFixed(0).padStart(6)} KB  ${rel}`);
}

// 3. árvore nova sobre a existente
const newTree = ghJson([
  'api',
  '-X',
  'POST',
  `repos/${REPO}/git/trees`,
], JSON.stringify({ base_tree: baseTree, tree }));
console.log(`árvore criada: ${newTree.sha.slice(0, 7)}`);

// 4. commit
const message = [
  'feat: código completo do Marketplace Intelligence com as correções da varredura',
  '',
  '- extensão 3.2.0: sessionToken() definida (causa raiz da captura que nunca',
  '  completava), token no envelope do IPC, classificação de páginas do vendedor',
  '  nos tipos válidos do contrato, conta criada antes da ingestão',
  '- painel: payloads corrigidos (keyword.gap, competitor.relations,',
  '  adapter.diagnostics, busca de concorrentes normalizada)',
  '- serviço: guard.evaluate valida o contexto e responde o que falta;',
  '  report.export gera CSV/JSON reais por tipo',
  '- documentação: DOCUMENTACAO-COMPLETA.txt regerada a partir do código',
  '  (22 partes) e checklist de 246 itens em MD e PDF',
  '- 177/177 testes aprovados, tsc limpo',
].join('\n');

const commit = ghJson([
  'api',
  '-X',
  'POST',
  `repos/${REPO}/git/commits`,
], JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }));
console.log(`commit: ${commit.sha}`);

// 5. move o branch
ghJson([
  'api',
  '-X',
  'PATCH',
  `repos/${REPO}/git/refs/heads/${BRANCH}`,
], JSON.stringify({ sha: commit.sha }));

console.log(`OK https://github.com/${REPO}/commit/${commit.sha}`);
