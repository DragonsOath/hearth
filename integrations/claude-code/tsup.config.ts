import { defineConfig } from "tsup";

/**
 * One self-contained file inside the plugin, so a machine needs only Node
 * to run the companion: no install step, no node_modules.
 */
export default defineConfig({
  entry: { companion: "src/main.ts" },
  outDir: "plugin/companion",
  format: "esm",
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [/.*/],
  outExtension: () => ({ js: ".mjs" }),
  banner: {
    // Bundled CommonJS dependencies may call require().
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
