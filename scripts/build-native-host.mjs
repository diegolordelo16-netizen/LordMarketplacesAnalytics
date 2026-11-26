/**
 * Compila o host de mensagens nativas (dist/native-host/native-host.js).
 * O instalador o embrulha em um .exe (Node SEA) ou chama o node.exe embarcado.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'dist', 'native-host');
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  legalComments: 'none',
  external: ['node:sqlite', 'node:*'],
  alias: {
    '@mi/shared': join(root, 'packages/shared/src/index.ts'),
    '@mi/native-host': join(root, 'packages/native-host/src/index.ts'),
    '@mi/local-agent': join(root, 'packages/local-agent/src/index.ts'),
  },
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [join(root, 'packages/native-host/src/standalone.ts')],
  outfile: join(outdir, 'native-host.js'),
});

await build({
  ...common,
  entryPoints: [join(root, 'packages/native-host/src/register-cli.ts')],
  outfile: join(outdir, 'register.js'),
});

// O pacote raiz é ESM: o bundle CJS precisa de package.json próprio para ser lido como CommonJS.
writeFileSync(join(outdir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));

console.log('OK  dist/native-host/native-host.js');
