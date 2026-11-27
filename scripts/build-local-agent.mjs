/**
 * Compila o serviço local em um único arquivo CommonJS (dist/local-agent/main.js).
 * Alvos: Node.js 22.13+ (Windows x64). node:sqlite fica externo (é builtin).
 */
import { build } from 'esbuild';
import { mkdirSync, cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'dist', 'local-agent');
mkdirSync(outdir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(root, 'packages/local-agent/src/cli.ts')],
  outfile: join(outdir, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  external: ['node:sqlite', 'node:*'],
  define: { 'process.env.MI_VERSION': JSON.stringify(pkg.version) },
  alias: {
    '@mi/shared': join(root, 'packages/shared/src/index.ts'),
    '@mi/native-host': join(root, 'packages/native-host/src/index.ts'),
    '@mi/local-agent': join(root, 'packages/local-agent/src/index.ts'),
  },
  logLevel: 'info',
});

// Painel local (HTML/CSS/JS) é servido pelo próprio serviço.
// O painel é servido direto de panel/src (index.html, app.js, app.css, prestart.*).
// Manter uma cópia em dist/ criava duas versões divergentes do mesmo arquivo.
const panelSrc = join(root, 'packages/local-agent/panel/src');
const panelOut = join(outdir, 'panel', 'dist');
rmSync(panelOut, { recursive: true, force: true });
cpSync(panelSrc, panelOut, { recursive: true });
const panelFiles = readdirSync(panelOut).filter((f) => !f.startsWith('.'));
console.log(`painel: ${panelFiles.length} arquivos (${panelFiles.join(', ')})`);

// Migrações precisam existir ao lado do bundle: o serviço as aplica na inicialização.
cpSync(join(root, 'packages/local-agent/migrations'), join(outdir, 'migrations'), { recursive: true });
// Distribuição da licença MIT do código incorporado e ponte MCP opcional.
mkdirSync(join(outdir,'third-party','open-seo'),{recursive:true});
cpSync(join(root,'third-party','open-seo','LICENSE'),join(outdir,'third-party','open-seo','LICENSE'));
cpSync(join(root,'scripts','openseo-mcp.mjs'),join(outdir,'openseo-mcp.mjs'));
// O pacote raiz é ESM: o bundle CJS precisa de package.json próprio para ser lido como CommonJS.
writeFileSync(join(outdir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));

console.log(`OK  dist/local-agent/main.js (${pkg.version}) + migrations/`);
