import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const output = resolve(process.argv[2] ?? "../docs/assets/fase-1.gif");
const size = { width: 1280, height: 800 };

const work = mkdtempSync(join(tmpdir(), "gdrive-central-"));
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: work, size } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

await page.goto(baseURL);
await page.locator("text=/^#\\d+$/").first().waitFor({ timeout: 60_000 });
await pause(9000);

const box = await page.getByTestId("mapa").boundingBox();
await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.82);
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -240);
  await pause(180);
}
await pause(7000);

const card = page.locator("text=/^#\\d+$/").first();
await card.click();
await page.waitForURL(/\/pedido\/\d+/);
await pause(9000);

await context.close();
await browser.close();

const video = readdirSync(work).find((f) => f.endsWith(".webm"));
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-i",
  join(work, video),
  "-vf",
  "fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  output,
]);
rmSync(work, { recursive: true, force: true });
console.log(`gravado em ${output}`);
