import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const PROXY_TARGET = "http://127.0.0.1:4173";

// The Node admin server serves the built bundle from `public/` via serveStatic
// (no SPA fallback), so we build a single-route app straight into `../public`.
export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: PROXY_TARGET, changeOrigin: true },
      "/preview": { target: PROXY_TARGET, changeOrigin: true },
      "/p": { target: PROXY_TARGET, changeOrigin: true }
    }
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    assetsDir: "assets",
    // The only >500 KB chunk is the lazily-loaded CodeMirror editor, so the
    // default warning would be a false alarm for the initial paint.
    chunkSizeWarningLimit: 700,
    // Keep the editor (CodeMirror) lazy and split heavy vendors so the initial
    // shell stays cacheable and lean.
    rollupOptions: {
      output: {
        manualChunks: {
          "dnd-vendor": [
            "@dnd-kit/core",
            "@dnd-kit/sortable",
            "@dnd-kit/utilities"
          ],
          "motion-vendor": ["framer-motion"]
        }
      }
    }
  }
});
