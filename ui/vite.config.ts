import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 打包产物直接给 Tauri 用（../dist），开发时跑 1420 端口
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "safari16",
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
