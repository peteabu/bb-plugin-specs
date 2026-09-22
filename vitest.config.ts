import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["*.test.ts", "{tests,hooks,lib,components}/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
