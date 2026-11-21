import { defineConfig, type Plugin, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;

/**
 * Copia o manifest.json para dist/ após o build.
 */
function copyManifest(): Plugin {
  return {
    name: "lma-copy-manifest",
    apply: "build",
    closeBundle() {
      const dist = resolve(root, "dist");
      if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
      copyFileSync(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
    },
  };
}

/**
 * Build da extensão em duas passadas.
 *
 * Restrição do Chrome: content script NÃO pode ter `import` — precisa ser um
 * arquivo único e autocontido. Com várias entradas, o Rollup extrai módulos
 * compartilhados para um chunk e quebra essa regra. Por isso:
 *   1) build "content"  — uma única entrada, tudo inline;
 *   2) build "principal" — Side Panel + service worker.
 * O segundo não limpa dist/ (emptyOutDir: false) para preservar o content.js.
 */
const contentOnly = process.env.LMA_BUILD_TARGET === "content";

export default defineConfig({
  plugins: [react(), copyManifest()] as PluginOption[],
  build: {
    outDir: "dist",
    emptyOutDir: !contentOnly,
    target: "chrome120",
    rollupOptions: contentOnly
      ? {
          input: resolve(root, "src/content/content-script.ts"),
          output: {
            entryFileNames: "content.js",
            inlineDynamicImports: true,
          },
        }
      : {
          input: {
            sidepanel: resolve(root, "sidepanel.html"),
            background: resolve(root, "src/background/service-worker.ts"),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === "background" ? "[name].js" : "assets/[name]-[hash].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash][extname]",
          },
        },
  },
});
