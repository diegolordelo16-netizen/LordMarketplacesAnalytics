/**
 * Empacota a extensão MV3 em dist/extension (sem transpilação: JS nativo do
 * navegador). Valida o manifest e confere que todo arquivo citado existe.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'packages/extension');
const out = join(root, 'dist/extension');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));

const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...(manifest.web_accessible_resources ?? [])
    .flatMap((w) => w.resources ?? [])
    .filter((rel) => !rel.includes('*')),
].filter(Boolean);

const missing = referenced.filter((rel) => !existsSync(join(src, rel)));
if (missing.length) {
  console.error(`ERRO: arquivos citados no manifest não existem: ${missing.join(', ')}`);
  process.exit(1);
}

// O service worker é um arquivo solto na raiz da extensão: sem esta cópia o
// Chrome recusa o manifest ("Não foi possível carregar o script de segundo plano").
cpSync(join(src, 'manifest.json'), join(out, 'manifest.json'));
for (const file of [manifest.background?.service_worker].filter(Boolean)) {
  cpSync(join(src, file), join(out, file));
}
for (const dir of ['content', 'panel']) cpSync(join(src, dir), join(out, dir), { recursive: true });
if (existsSync(join(src, '_locales'))) cpSync(join(src, '_locales'), join(out, '_locales'), { recursive: true });

// Ícones PNG são gerados pelo script de build (o Chrome não aceita SVG em manifest.icons).
const iconScript = join(root, 'scripts', 'make-icons.mjs');
await import(`file://${iconScript.replace(/\\/g, '/')}`).then((m) => m.makeIcons(join(out, 'icons')));

const total = referenced.length;
const bytes = statSync(join(out, 'manifest.json')).size;
console.log(`OK  dist/extension (${total} arquivos referenciados, manifest ${bytes}B)`);
