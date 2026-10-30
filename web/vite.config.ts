import { defineConfig } from "vite";

// No React plugin: esbuild compiles JSX with the automatic runtime. No fast refresh, fewer dependencies.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8787", "/healthz": "http://127.0.0.1:8787" } },
});
