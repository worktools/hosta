import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import path from "path";

const legoRoot = path.resolve(
  __dirname,
  "../../../work/asight/generative-lego/packages",
);

export default defineConfig({
  root: "frontend",
  plugins: [react(), vanillaExtractPlugin()],
  resolve: {
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "@generative-lego/shared": path.join(legoRoot, "shared/src/index.ts"),
      "@generative-lego/lego-react": path.join(
        legoRoot,
        "lego-react/src/index.ts",
      ),
      "@generative-lego/gui-framework": path.join(
        legoRoot,
        "gui-framework/src/index.ts",
      ),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/llms.txt": "http://127.0.0.1:4173",
      "/health": "http://127.0.0.1:4173",
      "/invoke": "http://127.0.0.1:4173",
      "/hooks": "http://127.0.0.1:4173",
    },
  },
  // Keep generated browser assets out of the source tree.
  build: { outDir: "../dist", emptyOutDir: true },
});
