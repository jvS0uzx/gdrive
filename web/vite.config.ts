import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const target = process.env.GDRIVE_URL ?? "http://localhost:8085";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      "/api": target,
      "/ws": { target, ws: true },
      "/city": target,
      "/route": target,
    },
  },
});
