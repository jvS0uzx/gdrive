import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const output = resolve(process.argv[2] ?? "../videos/gdrive.mp4");
const size = { width: 1920, height: 1080 };
const padding = { top: 32, bottom: 32, right: 32, left: 400 };

const places = {
  barra: [-13.0045, -38.525],
  itapua: [-12.9445, -38.3627],
  comercio: [-12.9705, -38.5125],
  rioVermelho: [-13.011, -38.4915],
  mar: [-13.005, -38.44],
  nazare: [-12.976, -38.506],
};

const meta = await (await fetch(`${baseURL}/city`)).json();
const mercator = (lat, lon) => [
  (lon + 180) / 360,
  (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2,
];
const [minLon, minLat, maxLon, maxLat] = meta.bbox;
const [left, bottom] = mercator(minLat, minLon);
const [right, top] = mercator(maxLat, maxLon);
const width = size.width - padding.left - padding.right;
const height = size.height - padding.top - padding.bottom;
const scale = Math.min(width / (right - left), height / (bottom - top));
const screen = ([lat, lon]) => {
  const [x, y] = mercator(lat, lon);
  return {
    x: padding.left + width / 2 + (x - (left + right) / 2) * scale,
    y: padding.top + height / 2 + (y - (top + bottom) / 2) * scale,
  };
};

const work = mkdtempSync(join(tmpdir(), "gdrive-video-"));
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: work, size } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

const caption = (text) =>
  page.evaluate((t) => {
    let el = document.getElementById("legenda-video");
    if (!el) {
      el = document.createElement("div");
      el.id = "legenda-video";
      Object.assign(el.style, {
        position: "fixed",
        left: "calc(400px + (100% - 432px) / 2)",
        top: "28px",
        transform: "translateX(-50%)",
        pointerEvents: "none",
        padding: "14px 26px",
        borderRadius: "14px",
        background: "rgba(13,16,22,0.88)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "#f4f4f5",
        font: "600 26px Inter, ui-sans-serif, system-ui, sans-serif",
        letterSpacing: "-0.01em",
        zIndex: 10,
        transition: "opacity 300ms",
        whiteSpace: "nowrap",
      });
      document.body.appendChild(el);
    }
    el.style.opacity = t ? "1" : "0";
    if (t) el.textContent = t;
  }, text);

const click = async (point) => {
  const p = screen(point);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await pause(250);
  await page.mouse.click(p.x, p.y);
};

await page.goto(baseURL);
await page.getByText("Clique no mapa para marcar a origem.").waitFor({ timeout: 60_000 });
await pause(800);
await caption("Salvador de verdade: 21.815 cruzamentos do OpenStreetMap");
await pause(3500);

await caption("Barra → Itapuã: a rota mais rápida, com a velocidade de cada via");
await click(places.barra);
await pause(600);
await click(places.itapua);
await page.getByTestId("tempo").waitFor();
await pause(7000);

await caption("Com chuva, a mesma rota fica 40% mais lenta");
await page.getByTestId("chuva").check();
await page.getByText("com chuva").waitFor();
await pause(3500);
await page.getByTestId("chuva").uncheck();
await pause(600);

await caption("Comércio → Rio Vermelho");
await click(places.comercio);
await pause(600);
await click(places.rioVermelho);
await page.getByTestId("tempo").waitFor();
await pause(6000);

await caption("Clique no mar: o servidor recusa em vez de inventar rota");
await click(places.barra);
await pause(500);
await click(places.mar);
await page.getByText("destino: ponto fora da cidade").waitFor();
await pause(3000);

await caption("De perto: as ruas de verdade e as setas de mão única");
const center = screen(places.nazare);
await page.mouse.move(center.x, center.y, { steps: 10 });
for (let i = 0; i < 15; i++) {
  await page.mouse.wheel(0, -260);
  await pause(140);
}
await pause(1500);
await page.mouse.down();
await page.mouse.move(center.x + 350, center.y + 40, { steps: 25 });
await page.mouse.up();
await pause(1200);
await page.mouse.click(center.x + 180, center.y + 160);
await pause(600);
await page.mouse.click(center.x + 540, center.y - 70);
await page.getByTestId("tempo").waitFor();
await pause(6000);

await caption("GDrive · fase 0 de 4: mapa e roteador");
await pause(3000);

await context.close();
await browser.close();

const video = readdirSync(work).find((f) => f.endsWith(".webm"));
mkdirSync(dirname(output), { recursive: true });
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-i",
  join(work, video),
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-movflags",
  "+faststart",
  output,
]);
rmSync(work, { recursive: true, force: true });
console.log(`gravado em ${output}`);
