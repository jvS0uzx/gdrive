import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const engine = process.env.ENGINE_URL ?? "http://localhost:8086";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      "/city": engine,
      "/route": engine,
    },
  },
});
