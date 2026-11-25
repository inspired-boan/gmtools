import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 约定：固定端口、不清理终端、仅注入 TAURI_ 前缀环境变量
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
