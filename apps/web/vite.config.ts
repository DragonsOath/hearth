import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * Writes .br and .gz copies of large built files (the grammar checker's
 * WebAssembly is 16 MB raw, about 7.5 MB compressed) next to them;
 * Hearth's static server sends a compressed copy to browsers that accept it.
 * Built-in zlib only, no extra dependency.
 */
function precompress(): Plugin {
  return {
    name: "dc-precompress",
    apply: "build",
    // After the files are written, so the copies match exactly what is served.
    writeBundle(options, bundle) {
      const dir = options.dir ?? "dist";
      for (const fileName of Object.keys(bundle)) {
        if (/\.(woff2?|png|jpe?g|webp|avif|br|gz)$/.test(fileName)) continue;
        const file = path.join(dir, fileName);
        const bytes = readFileSync(file);
        if (bytes.length < 64 * 1024) continue;
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(bytes, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 9,
              [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          }),
        );
        writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
      }
    },
  };
}

const apiTarget = `http://127.0.0.1:${process.env.DC_PORT || 7400}`;

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    host: process.env.DC_HOST || "127.0.0.1",
    port: Number(process.env.DC_WEB_PORT || 7401),
    strictPort: true,
    proxy: { "/api": apiTarget },
  },
});
