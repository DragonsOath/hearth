import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages,integrations,services}/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
  },
});
