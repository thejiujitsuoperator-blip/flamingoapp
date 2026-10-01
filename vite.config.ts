import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
  // `--mode artifact` builds one bundle (no lazy chunks) so it can be inlined into a single HTML page.
  ...(mode === "artifact" && {
    base: "./",
    build: {
      outDir: "dist-artifact",
      assetsInlineLimit: 100_000,
      rolldownOptions: { output: { inlineDynamicImports: true } },
    },
  }),
}));
