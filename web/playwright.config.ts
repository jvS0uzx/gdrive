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
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
