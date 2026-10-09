import { defineConfig } from "vitest/config";

// Tauri loads the dev server from this fixed port (tauri.conf.json devUrl).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
  test: { environment: "jsdom" },
});
