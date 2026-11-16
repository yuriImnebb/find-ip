import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  server: {
    proxy: {
      "/api": process.env.API_PROXY_TARGET || "http://127.0.0.1:3000",
    },
  },
  build: {
    rollupOptions: {
      input: [resolve(root, "index.html"), resolve(root, "privacy.html")],
    },
  },
});
