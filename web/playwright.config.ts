import { defineConfig } from "@playwright/test";

const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8085",
    viewport: { width: 1280, height: 800 },
    launchOptions: { executablePath },
  },
  // A chuva da simulação é global: o engine aplica quando há chuva em qualquer rota.
  // Testes que ligam a chuva rodam depois dos demais, senão quebram a medição de rota seca.
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: "**/operacao.spec.ts" },
    { name: "simulacao", use: { browserName: "chromium" }, testMatch: "**/operacao.spec.ts", dependencies: ["chromium"] },
  ],
});
