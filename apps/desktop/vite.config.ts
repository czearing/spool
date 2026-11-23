import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./dev/api-plugin.ts";

export default defineConfig({
  plugins: [react(), apiPlugin()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
