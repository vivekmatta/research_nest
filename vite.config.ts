import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        "content/content-script": resolve(__dirname, "src/content/content-script.ts"),
        "popup/popup": resolve(__dirname, "src/popup/popup.ts"),
        "dashboard/dashboard": resolve(__dirname, "src/dashboard/dashboard.ts"),
        "options/options": resolve(__dirname, "src/options/options.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
    target: "es2022",
    minify: false,
  },
  publicDir: "public",
});
