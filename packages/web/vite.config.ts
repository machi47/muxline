import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:7338",
        ws: true,
      },
    },
  },
});
