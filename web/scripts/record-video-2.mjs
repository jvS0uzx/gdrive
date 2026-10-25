// Vídeo 2 (fase 3): a carga de 20 mil entregadores subindo no Grafana, a central com a cidade
// cheia, o gargalo da primeira medição e o antes e depois. Os números das legendas vêm dos CSV
// da matriz e do Prometheus na hora da gravação, nunca escritos à mão.
//
//   ANTES=../docs/escala/<rodada sem lote>.csv DEPOIS=../docs/escala/<rodada final>.csv \
//     node scripts/record-video-2.mjs ../videos/<data>-video-2-fase-3/gdrive-video-2.mp4
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const grafana = process.env.GRAFANA ?? "http://127.0.0.1:3001";
const prometheus = process.env.PROMETHEUS ?? "http://127.0.0.1:9090";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const output = resolve(process.argv[2] ?? "../videos/gdrive-video-2.mp4");
const engines = Number(process.env.ENGINES ?? 4);
const couriers = Number(process.env.COURIERS ?? 20000);
const viewport = { width: 1440, height: 810 };
const videoSize = { width: 1920, height: 1080 };

const GIFS = {
  "fase-3.gif": [
    ["carga", "central", 4],
    ["central", "gargalo", 1.5],
    ["resultado", "fim", 1],
  ],
};

const br = (v, digits = 0) => v.toLocaleString("pt-BR", { maximumFractionDigits: digits });

function readCsv(path) {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const keys = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])));
}

function fanoutAt(rows, n) {
  const row = rows.find((r) => Number(r.engines) === n && Number(r.entregadores) === couriers);
  return row ? Number(row.fanout_p99_ms) : null;
}

function compose(args, env = {}) {
  execFileSync("docker", ["compose", ...args], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
}

async function query(expr) {
  const res = await fetch(`${prometheus}/api/v1/query?${new URLSearchParams({ query: expr })}`);
  const body = await res.json();
  return body.data.result.reduce((sum, s) => sum + (Number.isNaN(Number(s.value[1])) ? 0 : Number(s.value[1])), 0);
}

function exportGifs(marks, video, dir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, segments] of Object.entries(GIFS)) {
    const cuts = segments.map(
      ([from, to, speed], i) => `[0:v]trim=${marks[from].toFixed(2)}:${marks[to].toFixed(2)},setpts=(PTS-STARTPTS)/${speed}[s${i}]`,
    );
    const joined = segments.map((_, i) => `[s${i}]`).join("");
    const filter = [
      ...cuts,
      `${joined}concat=n=${segments.length}:v=1:a=0,fps=6,scale=640:-1:flags=lanczos,split[a][b]`,
      "[a]palettegen=max_colors=96:stats_mode=diff[p]",
      "[b][p]paletteuse=dither=none:diff_mode=rectangle",
    ].join(";");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-filter_complex", filter, join(dir, name)]);
    console.log(`GIF ${join(dir, name)}`);
  }
}

const marksFile = output.replace(/\.mp4$/, ".cenas.json");
if (process.env.GIFS_ONLY) {
  exportGifs(JSON.parse(readFileSync(marksFile, "utf8")), output, resolve(process.env.GIFS_ONLY));
  process.exit(0);
}

const before = readCsv(resolve(process.env.ANTES));
const after = readCsv(resolve(process.env.DEPOIS));
const ab = readCsv(resolve(process.env.AB ?? join(root, "docs/escala", `ab-lote-1-engine-${couriers}.csv`)));
// Desde quando o painel do gargalo mostra a fila do pool: precisa pegar a medição de antes do lote.
const bottleneckSince = Date.parse(process.env.GARGALO_DESDE ?? new Date(Date.now() - 3 * 3600_000).toISOString());
const comparison = resolve(process.env.COMPARACAO ?? join(root, "docs/escala", `comparacao-${couriers}.svg`));
const beforeOne = fanoutAt(before, 1);
const afterBy = [1, 2, 4].map((n) => [n, fanoutAt(after, n)]).filter(([, v]) => v !== null);

compose(["up", "-d", "--no-deps", "--scale", `engine=${engines}`, "engine"], { ENGINE_REPLICAS: String(engines) });
for (let i = 0; (await query('count(up{job="engine"} == 1)')) !== engines; i++) {
  if (i > 60) throw new Error(`Prometheus não viu ${engines} engines`);
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 15_000));

const work = mkdtempSync(join(tmpdir(), "gdrive-video-"));
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport, recordVideo: { dir: work, size: viewport } });
const page = await context.newPage();
const recordingFrom = Date.now();
// Cache do navegador é por contexto: o Grafana precisa ser aberto nesta mesma página, e esse
// trecho de carregamento é cortado na conversão.
await page.goto(`${grafana}/d/gdrive-escala?orgId=1&kiosk&from=now-3m&to=now`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
await page.goto(baseURL);
await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
const startedAt = Date.now();
const trim = (startedAt - recordingFrom) / 1000;
const marks = {};
const elapsed = () => (Date.now() - startedAt) / 1000;
const mark = (name) => {
  marks[name] = elapsed();
};
// Trechos de tela carregando, cortados na conversão: o Grafana reinicia o app a cada navegação.
const gaps = [];
const loading = async (work) => {
  const from = elapsed();
  await work();
  gaps.push([from, elapsed()]);
};
const central = () =>
  loading(async () => {
    await page.goto(baseURL);
    await page.getByTestId("card-pedido").first().waitFor({ timeout: 60_000 });
    await pause(800);
  });
const pause = (ms) => page.waitForTimeout(ms);

const PLACES = {
  map: { left: "calc(21rem + (100% - 21rem) / 2)", top: "64px", bottom: "auto", transform: "translateX(-50%)", textAlign: "center", maxWidth: "820px" },
  bottom: { left: "50%", top: "auto", bottom: "40px", transform: "translateX(-50%)", textAlign: "center", maxWidth: "1100px" },
};

const caption = (text, place = "bottom") =>
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
          background: "rgba(10,27,42,0.94)",
          border: "1px solid rgba(238,242,245,0.14)",
          color: "#eef2f5",
          font: "600 21px 'IBM Plex Sans Variable', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
          letterSpacing: "-0.01em",
          lineHeight: "1.35",
          zIndex: 2147483647,
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

// Janela curta: com 6 min, o painel ainda mostrava a carga da rodada anterior.
const dashboard = async (extra = "&from=now-3m&to=now") => {
  await page.goto(`${grafana}/d/gdrive-escala?orgId=1&kiosk&refresh=5s${extra}`, { waitUntil: "networkidle" });
  // A primeira abertura do Grafana na sessão passa segundos na tela de carregamento.
  await page
    .locator(".react-grid-layout, [data-viz-panel-key]")
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => console.log("painel do Grafana sem o seletor esperado; seguindo"));
  await pause(3500);
};

const loadEnv = {
  ENGINE_REPLICAS: String(engines),
  LOAD_COURIERS: String(couriers),
  LOAD_RAMP_STEP: "2000",
  LOAD_RAMP_EVERY: "5s",
  LOAD_DURATION: "600s",
};

try {
  mark("abertura");
  await pause(1500);
  await caption("Fase 3: o tempo real em várias instâncias, e o número medido", "map");
  await pause(5500);

  mark("carga");
  compose(["--profile", "load", "up", "-d", "--no-deps", "--force-recreate", "load"], loadEnv);
  await loading(() => dashboard());
  await caption(`${br(couriers)} entregadores sintéticos entram em rampa, cada um com WebSocket real pelo nginx`);
  await pause(12_000);
  await caption(`Uma posição a cada 2 s por entregador: ${br(couriers / 2)} posições por segundo`);
  await pause(12_000);
  await caption(`${engines} instâncias do engine; o nginx divide as conexões entre elas`);
  for (let i = 0; (await query("sum(rate(gdrive_positions_received_total[30s]))")) < couriers * 0.45; i++) {
    if (i > 40) break;
    await pause(3000);
  }
  // A rampa abre milhares de WebSockets de uma vez e o p99 dela não é o do regime: mede depois.
  await caption("Cada instância recebe todas as posições pelo pub/sub do Redis e grava as suas em lote, a cada 20 ms");
  await pause(14_000);
  await caption("Engines, Redis, nginx, gerador e k6 dividem o mesmo notebook");
  await pause(14_000);
  // O p99 ao vivo sai pior que o da matriz: aqui o Chromium renderiza o mapa e grava o vídeo no
  // mesmo notebook. A legenda diz isso em vez de citar o número ao vivo como resultado.
  await caption("Fan-out: da posição recebida até ela chegar em todas as instâncias. Ao vivo, com este navegador gravando ao lado");
  await pause(10_000);

  mark("central");
  await central();
  await caption(`A central recebe a cidade inteira a cada 500 ms: ${br(couriers)} pontos andando pelas ruas`, "map");
  await pause(9000);
  // Mesmo zoom do vídeo 1: evento de roda direto no canvas, que o MapLibre anima.
  const box = await page.getByTestId("mapa").boundingBox();
  const focus = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.5 };
  for (let i = 0; i < 6; i++) {
    await page.evaluate(
      ({ x, y }) =>
        document
          .querySelector(".maplibregl-canvas")
          ?.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, clientX: x, clientY: y, bubbles: true, cancelable: true })),
      focus,
    );
    await pause(250);
  }
  await pause(7000);

  mark("gargalo");
  const hours = Math.max(1, Math.ceil((Date.now() - bottleneckSince) / 3600_000));
  // Sem subconsulta: com passo de 15 s, os picos da fila sumiam (750 no lugar de 5.323).
  const queued = await query(`max(max_over_time(gdrive_redis_pool_pending[${hours}h]))`);
  await loading(() => dashboard(`&viewPanel=panel-47&from=${bottleneckSince}&to=now`));
  await caption(
    `Primeira medição com ${br(couriers)}: p99 de ${br(beforeOne ?? 0)} ms, e até ${br(queued)} posições na fila esperando conexão com o Redis`,
  );
  await pause(10_000);
  await caption("Era uma ida e volta ao Redis por posição. Com a gravação em lote, a fila quase some e a CPU cai à metade");
  await pause(10_000);

  mark("resultado");
  const svg = readFileSync(comparison, "utf8");
  await page.setContent(
    `<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a1b2a">` +
      `<img style="width:min(1100px,92vw)" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`,
  );
  const single = ab.map((r) => Number(r.fanout_p99_ms));
  const summary = afterBy
    .filter(([n]) => n > 1)
    .map(([n, v]) => `${n} engines: ${br(v)} ms`)
    .join(" · ");
  await caption(
    `Com ${br(couriers)}, depois do lote: ${summary}. Com 1 engine só, instável: de ${br(Math.min(...single))} a ${br(Math.max(...single))} ms`,
  );
  await pause(11_000);

  mark("fim");
  await central();
  await caption("Gdrive · fase 3 de 4 · próxima: copiloto de alertas", "map");
  await pause(5000);
  mark("final");
} finally {
  compose(["--profile", "load", "stop", "-t", "30", "load"]);
  await context.close();
  await browser.close();
}

// Tempos do arquivo bruto: o aquecimento (0 até trim) e cada carregamento saem do vídeo, e as
// marcas das cenas recuam o que foi cortado antes delas.
const cuts = [[0, trim], ...gaps.map(([a, b]) => [trim + a, trim + b])];
const kept = cuts.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");
for (const [name, at] of Object.entries(marks)) {
  marks[name] = at - gaps.filter(([, b]) => b <= at).reduce((sum, [a, b]) => sum + (b - a), 0);
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
  `fps=30,select='not(${kept})',setpts=N/30/TB,scale=${videoSize.width}:${videoSize.height}:flags=lanczos`,
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

writeFileSync(marksFile, JSON.stringify(marks, null, 2));
if (process.env.GIFS) exportGifs(marks, output, resolve(process.env.GIFS));
