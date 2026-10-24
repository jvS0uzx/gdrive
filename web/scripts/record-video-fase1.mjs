import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const output = resolve(process.argv[2] ?? "../videos/gdrive-fase-1.mp4");
const size = { width: 1920, height: 1080 };

const api = async (path) => (await fetch(`${baseURL}${path}`)).json();

async function showcaseOrder() {
  const active = [
    ...(await api("/api/orders?status=a_caminho_da_loja&limit=40")),
    ...(await api("/api/orders?status=em_rota&limit=40")),
  ];
  let fallback = null;
  for (const order of active) {
    const dispatch = await api(`/api/orders/${order.id}/dispatch`);
    const accepted = dispatch.offers.find((o) => o.status === "aceita");
    if (!accepted || accepted.candidates.length < 2) continue;
    fallback ??= order.id;
    const nearest = accepted.candidates.reduce((a, b) => (b.distance_m < a.distance_m ? b : a));
    if (nearest.courier_id !== accepted.candidates[0].courier_id) return order.id;
  }
  return fallback ?? active[0]?.id;
}

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
        left: "50%",
        top: "64px",
        transform: "translateX(-50%)",
        maxWidth: "980px",
        padding: "14px 26px",
        borderRadius: "14px",
        background: "rgba(13,16,22,0.9)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "#f4f4f5",
        font: "600 25px Inter, ui-sans-serif, system-ui, sans-serif",
        letterSpacing: "-0.01em",
        textAlign: "center",
        zIndex: 50,
        pointerEvents: "none",
        transition: "opacity 300ms",
      });
      document.body.appendChild(el);
    }
    el.style.opacity = t ? "1" : "0";
    if (t) el.textContent = t;
  }, text);

const scrollTo = (testId) =>
  page.evaluate((id) => {
    document.querySelector(`[data-testid="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, testId);

await page.goto(baseURL);
await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
await pause(800);
await caption("Fase 1: pedidos de verdade, despachados ao vivo em Salvador");
await pause(5500);

const boxes = (await page.getByTestId("card-pedido").evaluateAll((els) =>
  els.map((el) => {
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }),
)).filter(([x, y]) => x > 420 && y > 80);
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const focus = { x: median(boxes.map((b) => b[0])), y: median(boxes.map((b) => b[1])) };
await caption("Cada pedido tem um card que muda de cor a cada etapa");
await page.mouse.move(focus.x, focus.y, { steps: 15 });
const wheel = (deltaY) =>
  page.evaluate(
    ({ x, y, deltaY }) => {
      document
        .querySelector(".maplibregl-canvas")
        ?.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { ...focus, deltaY },
  );
for (let i = 0; i < 8; i++) {
  await wheel(-260);
  await pause(180);
}
await pause(8000);
for (let i = 0; i < 8; i++) {
  await wheel(260);
  await pause(120);
}
await pause(1500);

const id = await showcaseOrder();
const card = page.locator("[data-testid=card-pedido]", { hasText: `#${id}` }).first();
await caption("Clique no pedido: a rota escolhida contra as alternativas");
await card.click({ force: true });
await page.getByTestId("analise-jornada").waitFor({ timeout: 15_000 });
await pause(7000);

await caption("O despacho oferece a corrida ao mais rápido pelas ruas, não ao mais perto");
await scrollTo("analise-despacho");
await pause(7000);

await caption("Rota prevista tracejada, rastro real por cima, e o desvio entre as duas");
await scrollTo("analise-jornada");
await pause(7000);

await caption("O que o cliente vê: o entregador no mapa e cada etapa ao vivo");
await page.getByRole("link", { name: /Abrir acompanhamento/ }).click();
await page.waitForURL(/\/pedido\/\d+/);
await pause(9000);

await page.goto(baseURL);
await page.getByTestId("card-pedido").first().waitFor({ timeout: 30_000 });
await caption("GDrive · fase 1 de 4: o núcleo do delivery");
await pause(4000);

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
console.log(`gravado em ${output} (pedido em destaque: #${id})`);
