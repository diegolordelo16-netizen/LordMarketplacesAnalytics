import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
    // Um worker por arquivo evita disputa de porta/loopback entre arquivos.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  ssr: {
    // node:sqlite é módulo embutido do Node: o Vite não pode tentar bundleá-lo.
    external: ["node:sqlite"],
  },
  optimizeDeps: {
    exclude: ["node:sqlite"],
  },
});
