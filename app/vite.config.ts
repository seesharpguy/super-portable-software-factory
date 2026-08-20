import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Only used by the dev server's /api proxy (`npm run dev` inside app/, for
// iterating on the SPA against a real spf ui process on the side). The
// packaged build never reaches this — one process serves both, same-origin.
const API_PORT = process.env.PORT ?? "4600";

export default defineConfig({
  plugins: [vue()],
  // Mount-point-agnostic: spf ui always serves this at the root it binds, but
  // relative URLs cost nothing and stop being wrong the first time someone
  // reverse-proxies it under a path prefix.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../src/ui/shared", import.meta.url)),
    },
  },
  server: {
    port: 4601,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // A sibling of dist/ in the published package — never dist/ itself, so
    // `emptyOutDir` here can never eat the compiled CLI.
    outDir: "../web",
    emptyOutDir: true,
    // Inlines the (now 48x48, ~1-2 KB each) provider icons as data URIs
    // instead of separate HTTP requests.
    assetsInlineLimit: 4096,
  },
});
