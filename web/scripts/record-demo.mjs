import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const output = resolve(process.argv[2] ?? "../docs/assets/fase-0.gif");
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
const size = { width: 1280, height: 800 };

const work = mkdtempSync(join(tmpdir(), "gdrive-demo-"));
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: work, size } });
const page = await context.newPage();

const pause = (ms) => page.waitForTimeout(ms);
const shot = async (name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

await page.goto(baseURL);
await page.getByText("Clique no mapa para marcar a origem.").waitFor({ timeout: 30_000 });
await pause(1500);
await shot("1-cidade");

const map = page.getByTestId("mapa");
const box = await map.boundingBox();
const at = (fx, fy) => ({ position: { x: box.width * fx, y: box.height * fy } });

await map.click(at(0.4375, 0.9));
await pause(700);
await map.click(at(0.773, 0.5875));
await page.getByTestId("tempo").waitFor();
await pause(6500);
await shot("2-rota");

await page.getByTestId("chuva").check();
await page.getByText("com chuva").waitFor();
await pause(3500);
await shot("3-chuva");
await page.getByTestId("chuva").uncheck();
await pause(800);

await page.mouse.move(box.x + box.width * 0.485, box.y + box.height * 0.875);
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, -260);
  await pause(160);
}
await pause(1500);
await map.click(at(0.55, 0.62));
await pause(600);
await map.click(at(0.76, 0.38));
await page.getByTestId("tempo").waitFor();
await pause(5000);
await shot("4-mao-unica");

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
  "fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  output,
]);
rmSync(work, { recursive: true, force: true });
console.log(`gravado em ${output}`);
