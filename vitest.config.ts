import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // node:sqlite é experimental: não consta em module.builtinModules, então o resolvedor do
  // vite-node removeria o prefixo "node:" e procuraria um arquivo "sqlite". O plugin
  // intercepta "sqlite"/"node:sqlite" e entrega o builtin real via createRequire.
  plugins: [
    {
      name: 'mi-keep-node-builtins',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'sqlite' || id === 'node:sqlite') return { id: 'node:sqlite', external: true };
        if (id.startsWith('node:')) return { id, external: true };
        return null;
      },
      // Fornece o builtin real; createRequire precisa de um caminho absoluto porque
      // import.meta.url pode ser undefined no transform do vite-node.
      load(id) {
        if (id === 'node:sqlite') {
          return {
            code: `import { createRequire } from 'node:module';
const req = createRequire(${JSON.stringify(r('./package.json'))});
const real = req('node:sqlite');
export const DatabaseSync = real.DatabaseSync;
export const StatementSync = real.StatementSync;
export const constants = real.constants;
export const backup = real.backup;
export default real;`,
            map: null,
          };
        }
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      '@mi/shared': r('./packages/shared/src/index.ts'),
      '@mi/data-intelligence': r('./packages/data-intelligence/src/index.ts'),
      '@mi/search-intelligence': r('./packages/search-intelligence/src/index.ts'),
      '@mi/market-intelligence': r('./packages/market-intelligence/src/index.ts'),
      '@mi/growth-engine': r('./packages/growth-engine/src/index.ts'),
      '@mi/voice-of-customer': r('./packages/voice-of-customer/src/index.ts'),
      '@mi/connectors': r('./packages/connectors/src/index.ts'),
      '@mi/forecasting': r('./packages/forecasting/src/index.ts'),
      '@mi/native-host': r('./packages/native-host/src/index.ts'),
      '@mi/local-agent': r('./packages/local-agent/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    reporters: ['default'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, execArgv: ['--experimental-sqlite'] } },
  },
});
