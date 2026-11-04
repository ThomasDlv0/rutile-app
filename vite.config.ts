import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error pas de @types/node dans ce projet
const host: string | undefined = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Tauri attend un port fixe et doit voir les erreurs Rust dans le terminal
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
