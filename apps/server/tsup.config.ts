import { defineConfig } from "tsup";

const common = {
  format: "esm" as const,
  platform: "node" as const,
  target: "node24",
  // `sqlite` only exists as `node:sqlite`; stripping the prefix breaks the built server.
  removeNodeProtocol: false,
};

export default defineConfig([
  {
    ...common,
    entry: {
      index: "src/index.ts",
      "reset-owner": "src/reset-owner.ts",
      "tools-cli": "src/tools-cli.ts",
      // The built-in voice's helper process (voice/pack.ts starts it beside the server).
      "voice-runner": "src/voice/runner.ts",
    },
    clean: true,
    sourcemap: true,
    // Workspace packages ship TypeScript source, so they are bundled in.
    noExternal: [/^@dragon-control\//],
  },
  {
    ...common,
    // The root-owned elevated executor: one self-contained file (Node built-ins only), installed
    // apart from the server, so nothing it runs can be changed by replacing Hearth's own files.
    entry: { "hearth-elevated": "src/elevated/main.ts" },
    outDir: "dist-elevated",
    clean: true,
    splitting: false,
    sourcemap: false,
  },
]);
