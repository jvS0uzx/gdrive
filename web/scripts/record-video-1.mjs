import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const output = resolve(process.argv[2] ?? "../videos/gdrive-video-1.mp4");
const viewport = { width: 1440, height: 810 };
const videoSize = { width: 1920, height: 1080 };
const courierSpeed = 10;

async function api(path, method = "GET", data) {
  const res = await fetch(`${baseURL}${path}`, {
    method,
    headers: data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

const get = async (path) => (await api(path)).body;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function meters(a, b) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function pickCourierAndStore() {
  const stores = await get("/api/stores?limit=5000");
  const offline = await get("/api/couriers?status=offline&limit=200");
  for (const courier of offline.filter((c) => c.id > 72)) {
    const near = stores
      .filter((s) => !s.manual)
      .map((s) => ({ store: s, d: meters(courier, s) }))
      .filter(({ d }) => d >= 400 && d <= 1500)
      .sort((a, b) => a.d - b.d);
    if (near.length) return { courier, store: near[0].store };
  }
  throw new Error("nenhum entregador offline com loja entre 400 m e 1,5 km");
}

async function showcaseOrder() {
  const active = [
    ...(await get("/api/orders?status=a_caminho_da_loja&limit=40")),
    ...(await get("/api/orders?status=em_rota&limit=40")),
  ];
  let fallback = null;
  for (const order of active) {
    const dispatch = await get(`/api/orders/${order.id}/dispatch`);
    const accepted = dispatch.offers.find((o) => o.status === "aceita");
    if (!accepted || accepted.candidates.length < 2) continue;
    fallback ??= order.id;
    const nearest = accepted.candidates.reduce((a, b) => (b.distance_m < a.distance_m ? b : a));
    if (nearest.courier_id !== accepted.candidates[0].courier_id) return order.id;
  }
  return fallback ?? active[0]?.id;
}

async function breakTwoCouriers() {
  const simulated = new Set((await get("/api/couriers?human=false&limit=500")).map((c) => c.id));
  const heading = (await get("/api/orders?status=a_caminho_da_loja&limit=20")).filter(
    (o) => o.courier_id !== null && simulated.has(o.courier_id),
  );
  const [silent, stopped] = heading;
  if (silent) await api(`/api/sim/couriers/${silent.courier_id}/sem_sinal`, "POST", { seconds: 150 });
  if (stopped) await api(`/api/sim/couriers/${stopped.courier_id}/parar`, "POST", { seconds: 150 });
}

const pizzerias = (await get("/api/stores?q=pizza&limit=40")).filter((s) => !s.manual);
const storeScene = pizzerias[3] ?? pizzerias[0];
const { courier, store: courierStore } = await pickCourierAndStore();
console.log(`loja da cena: #${storeScene.id} ${storeScene.name}; entregador #${courier.id} perto de #${courierStore.id} ${courierStore.name}`);

const work = mkdtempSync(join(tmpdir(), "gdrive-video-"));
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport, recordVideo: { dir: work, size: viewport } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

const PLACES = {
  map: { left: "calc(21rem + (100% - 21rem) / 2)", top: "64px", transform: "translateX(-50%)", textAlign: "center", maxWidth: "820px" },
  center: { left: "50%", top: "64px", transform: "translateX(-50%)", textAlign: "center", maxWidth: "900px" },
  between: { left: "calc((21rem + 100% - 26rem) / 2)", top: "64px", transform: "translateX(-50%)", textAlign: "center", maxWidth: "560px" },
  side: { left: "48px", top: "40%", transform: "none", textAlign: "left", maxWidth: "400px" },
};

const caption = (text, place = "center") =>
  page.evaluate(
    ({ t, style }) => {
      let el = document.getElementById("legenda-video");
      if (!el) {
        el = document.createElement("div");
        el.id = "legenda-video";
        Object.assign(el.style, {
          position: "fixed",
          padding: "12px 22px",
          borderRadius: "14px",
          background: "rgba(13,16,22,0.92)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "#f4f4f5",
          font: "600 21px Inter, ui-sans-serif, system-ui, sans-serif",
          letterSpacing: "-0.01em",
          lineHeight: "1.35",
          zIndex: 60,
          pointerEvents: "none",
          transition: "opacity 300ms",
        });
        document.body.appendChild(el);
      }
      Object.assign(el.style, style);
      el.style.opacity = t ? "1" : "0";
      if (t) el.textContent = t;
    },
    { t: text, style: PLACES[place] },
  );

const meta = await get("/city");
const mercator = (lat, lon) => [
  (lon + 180) / 360,
  (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2,
];
const fitPadding = 24;
const [minLon, minLat, maxLon, maxLat] = meta.bbox;
const [bl, bb] = mercator(minLat, minLon);
const [br, bt] = mercator(maxLat, maxLon);
const screen = (box, [lat, lon]) => {
  const fitW = box.width - 2 * fitPadding;
  const fitH = box.height - 2 * fitPadding;
  const fitScale = Math.min(fitW / (br - bl), fitH / (bb - bt));
  const [x, y] = mercator(lat, lon);
  return {
    x: box.x + fitPadding + fitW / 2 + (x - (bl + br) / 2) * fitScale,
    y: box.y + fitPadding + fitH / 2 + (y - (bt + bb) / 2) * fitScale,
  };
};
const clickAt = async (point) => {
  const box = await page.getByTestId("mapa").boundingBox();
  const p = screen(box, point);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await pause(250);
  await page.mouse.click(p.x, p.y);
};

const wheelAt = (focus, deltaY) =>
  page.evaluate(
    ({ x, y, deltaY }) => {
      document
        .querySelector(".maplibregl-canvas")
        ?.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { ...focus, deltaY },
  );

let phoneOrder = null;
try {
  await page.goto(baseURL);
  await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
  await pause(1200);
  await caption("GDrive: um delivery simulado sobre o mapa real de Salvador", "map");
  await pause(4000);
  await caption("Fases 0, 1 e 2: o mapa, o núcleo do delivery e a operação", "map");
  await pause(3500);

  await page.goto(`${baseURL}/rota`);
  await page.getByText("Clique no mapa para marcar a origem.").waitFor({ timeout: 60_000 });
  await pause(800);
  await caption("Fase 0 · roteador próprio sobre as ruas reais do OpenStreetMap", "map");
  await pause(2500);
  await clickAt([-13.0045, -38.525]);
  await pause(500);
  await clickAt([-12.9445, -38.3627]);
  await page.getByTestId("tempo").waitFor();
  await caption("Barra → Itapuã: a rota mais rápida, pela velocidade de cada via", "map");
  await pause(5000);
  await caption("Com chuva, a mesma rota fica 40% mais lenta", "map");
  await page.getByTestId("chuva").check();
  await page.getByText("com chuva").waitFor();
  await pause(3500);
  await page.getByTestId("chuva").uncheck();

  await page.goto(baseURL);
  await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
  await pause(800);
  await caption("Fase 1 · 60 entregadores e pedidos de verdade, despachados ao vivo", "map");
  await pause(4000);
  const boxes = (
    await page.getByTestId("card-pedido").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      }),
    )
  ).filter(([x, y]) => x > 360 && y > 80);
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const focus = { x: median(boxes.map((b) => b[0])), y: median(boxes.map((b) => b[1])) };
  await caption("Um card por pedido, que muda de cor a cada etapa", "map");
  await page.mouse.move(focus.x, focus.y, { steps: 12 });
  for (let i = 0; i < 7; i++) {
    await wheelAt(focus, -260);
    await pause(170);
  }
  await pause(5500);
  for (let i = 0; i < 7; i++) {
    await wheelAt(focus, 260);
    await pause(110);
  }
  await pause(1000);
  const showcase = await showcaseOrder();
  if (showcase) {
    await caption("Clique no pedido: a rota escolhida contra as alternativas", "between");
    await page.locator("[data-testid=card-pedido]", { hasText: `#${showcase}` }).first().click({ force: true });
    await page.getByTestId("analise-jornada").waitFor({ timeout: 15_000 });
    await pause(5500);
    await caption("A corrida vai para quem chega mais rápido pelas ruas, não para o mais perto", "between");
    await page.evaluate(() =>
      document.querySelector('[data-testid="analise-despacho"]')?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    await pause(6000);
    await page.keyboard.press("Escape");
  }

  await page.goto(`${baseURL}/loja/${storeScene.id}`);
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 30_000 });
  await caption("Fase 2 · a loja: aceita, prepara e avisa quando está pronto", "center");
  await pause(2500);
  const manual = page.getByRole("switch", { name: /Operar na mão/ });
  await manual.check();
  await pause(1200);
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/test-order") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Gerar pedido de teste" }).click(),
  ]);
  const storeOrder = (await created.json()).id;
  const card = (column) =>
    page.getByTestId(`coluna-${column}`).locator(`[data-testid="card-pedido-loja"][data-pedido="${storeOrder}"]`);
  await card("novos").waitFor({ timeout: 10_000 });
  await pause(2500);
  await card("novos").getByRole("combobox").selectOption("10");
  await pause(700);
  await card("novos").getByRole("button", { name: "Aceitar" }).click();
  await card("preparo").waitFor({ timeout: 10_000 });
  await caption("Enquanto a cozinha prepara, o despacho já procura o entregador", "center");
  await card("preparo")
    .getByTestId("situacao-entregador")
    .filter({ hasText: /a caminho|na loja/ })
    .waitFor({ timeout: 25_000 })
    .catch(() => undefined);
  await pause(3000);
  await card("preparo").getByRole("button", { name: "Marcar pronto" }).click();
  await card("prontos").waitFor({ timeout: 10_000 });
  await caption("Pronto: o entregador retira assim que chegar", "center");
  await pause(3500);
  await manual.uncheck();
  await pause(800);

  await breakTwoCouriers();
  await api(`/api/stores/${courierStore.id}/manual`, "PUT", { manual: true });
  await page.goto(`${baseURL}/entregador/${courier.id}?velocidade=${courierSpeed}`);
  await page.getByRole("button", { name: "Ficar online" }).waitFor({ timeout: 30_000 });
  await caption("O entregador pelo celular", "side");
  await pause(2500);
  await page.getByRole("button", { name: "Ficar online" }).click();
  await page.getByTestId("conexao").filter({ hasText: "GPS ao vivo" }).waitFor({ timeout: 15_000 });
  await page.getByTestId("mapa").and(page.locator("[data-ready=true]")).waitFor({ timeout: 30_000 });
  await caption("Online: manda a posição pelo mesmo WebSocket dos entregadores simulados", "side");
  await pause(3000);
  const order = await api(`/api/stores/${courierStore.id}/test-order`, "POST");
  phoneOrder = order.body.id;
  await api(`/api/stores/${courierStore.id}/orders/${phoneOrder}/accept`, "POST", { prep_minutes: 5 });
  const offer = page.getByTestId("oferta");
  const offered = await offer
    .waitFor({ timeout: 12_000 })
    .then(async () => (await get(`/api/couriers/${courier.id}`)).offer?.order_id === phoneOrder)
    .catch(() => false);
  if (offered) {
    await caption("A oferta chega com 30 s para aceitar", "side");
    await pause(3500);
    await offer.getByRole("button", { name: "Aceitar" }).click();
  } else {
    const view = await get(`/api/couriers/${courier.id}`);
    if (view.offer) await api(`/api/offers/${view.offer.id}/decline`, "POST", { courier_id: courier.id });
    const detail = await get(`/api/orders/${phoneOrder}`);
    if (detail.courier) await api(`/api/orders/${phoneOrder}/unassign`, "POST");
    await api(`/api/orders/${phoneOrder}/assign`, "POST", { courier_id: courier.id });
  }
  const ride = page.getByTestId("corrida");
  await ride.waitFor({ timeout: 15_000 });
  await caption("Piloto automático pela rota real; a chegada sai do GPS, a 50 m", "side");
  await ride.getByTestId("corrida-status").filter({ hasText: "Na loja" }).waitFor({ timeout: 120_000 });
  await caption("Na loja: a retirada só vale com o pedido pronto", "side");
  await pause(2500);
  await api(`/api/stores/${courierStore.id}/orders/${phoneOrder}/ready`, "POST");
  await ride.getByTestId("ainda-nao-pronto").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  await pause(1200);
  await ride.getByRole("button", { name: "Confirmar retirada" }).click();
  await caption("Retirado: agora até o cliente", "side");
  await ride.getByTestId("corrida-status").filter({ hasText: "No endereço do cliente" }).waitFor({ timeout: 120_000 });
  await pause(1500);
  await ride.getByRole("button", { name: "Confirmar entrega" }).click();
  await caption("Entregue", "side");
  await pause(2500);
  await page.getByRole("button", { name: "Ficar offline" }).click({ timeout: 10_000 }).catch(() => undefined);
  await api(`/api/stores/${courierStore.id}/manual`, "PUT", { manual: false });

  await page.goto(baseURL);
  await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
  await caption("A central vigia a operação: sem sinal, parado, fora da rota, atraso", "map");
  const alerts = page.getByTestId("lista-alertas").locator("button");
  await alerts.first().waitFor({ timeout: 40_000 }).catch(() => undefined);
  await pause(4000);
  if (await alerts.count()) {
    await alerts.first().click();
    await page.getByTestId("analise-operacao").waitFor({ timeout: 10_000 });
    await caption("Cada alerta explicado, com a ação ao lado", "between");
    await pause(4500);
    const release = page.getByTestId("desatribuir");
    if (await release.count()) {
      await release.click();
      await caption("Desatribuído: o despacho oferece o pedido a outro entregador", "between");
      await pause(5000);
    }
    await page.keyboard.press("Escape");
  }
  await caption("Chuva e pico de pedidos mudam a cidade na hora", "map");
  await page.getByTestId("chuva").click();
  await pause(1200);
  await page.getByTestId("pico-3").click();
  await pause(4000);
  await page.getByTestId("chuva").click();
  await page.getByTestId("pico-1").click();
  await pause(800);

  for (let i = 0; i < 20 && phoneOrder && !(await api(`/api/orders/${phoneOrder}/track`)).ok; i++) await sleep(500);
  await page.goto(`${baseURL}/historico`);
  await page.getByTestId("tabela-historico").waitFor({ timeout: 20_000 });
  await caption("Toda entrega fica gravada no PostGIS, com o trajeto e a rota prevista", "center");
  await pause(3500);
  const link = page.getByTestId("tabela-historico").getByRole("link", { name: `#${phoneOrder}`, exact: true });
  if (phoneOrder && (await link.count())) await link.click();
  else if (phoneOrder) await page.goto(`${baseURL}/historico/${phoneOrder}`);
  await page.getByTestId("mapa").and(page.locator("[data-ready=true]")).waitFor({ timeout: 30_000 });
  await caption("Replay: a rota prevista tracejada e o rastro de verdade no tempo", "map");
  await page.getByRole("button", { name: "4×" }).click();
  await page.getByTestId("replay-play").click();
  await pause(11_000);

  await page.goto(baseURL);
  await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
  await caption("GDrive · fases 0 a 2 de 4 · próxima: escala horizontal, com número", "map");
  await pause(4500);
} finally {
  await api("/api/sim", "PUT", { rain: false, rush: 1 });
  await api(`/api/stores/${storeScene.id}/manual`, "PUT", { manual: false });
  await api(`/api/stores/${courierStore.id}/manual`, "PUT", { manual: false });
  await context.close();
  await browser.close();
}

const recorded = readdirSync(work).find((f) => f.endsWith(".webm"));
mkdirSync(dirname(output), { recursive: true });
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-i",
  join(work, recorded),
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "18",
  "-vf",
  `scale=${videoSize.width}:${videoSize.height}:flags=lanczos`,
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-movflags",
  "+faststart",
  output,
]);
rmSync(work, { recursive: true, force: true });
console.log(`gravado em ${output} (entregador #${courier.id}, pedido do celular #${phoneOrder})`);
