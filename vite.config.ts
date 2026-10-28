import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = `http://127.0.0.1:${process.env.PI_WEB_PORT ?? "30142"}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: { "/api": { target: apiTarget, changeOrigin: false } },
  },
});
