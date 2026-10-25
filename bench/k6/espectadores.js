// Espectadores da fase 3: centrais que recebem o retrato a cada 500 ms e clientes que acompanham
// um pedido. O que interessa é se o retrato continua chegando no ritmo com a carga ligada.
import http from "k6/http";
import { WebSocket } from "k6/websockets";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE ?? "http://web";
const WS = BASE.replace(/^http/, "ws");
const CENTRALS = Number(__ENV.CENTRALS ?? 10);
const WATCHERS = Number(__ENV.WATCHERS ?? 200);
const HOLD = Number(__ENV.HOLD_SECONDS ?? 180);

const gap = new Trend("retrato_intervalo_ms", true);
const size = new Trend("retrato_bytes");
const received = new Counter("mensagens_recebidas");

const once = (vus, exec) => ({ executor: "per-vu-iterations", vus, iterations: 1, exec, maxDuration: `${HOLD + 60}s` });

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(95)", "p(99)"],
  scenarios: Object.fromEntries(
    [
      ["centrais", once(CENTRALS, "central")],
      ["pedidos", once(WATCHERS, "pedido")],
    ].filter(([, s]) => s.vus > 0),
  ),
};

export function setup() {
  const ids = [];
  for (const status of ["em_rota", "a_caminho_da_loja", "na_loja"]) {
    const res = http.get(`${BASE}/api/orders?status=${status}&limit=200`);
    if (res.status === 200) ids.push(...res.json().map((o) => o.id));
  }
  return { ids };
}

export function central() {
  const ws = new WebSocket(`${WS}/ws/watch/central`);
  let last = 0;
  ws.onmessage = (e) => {
    const now = Date.now();
    if (last) gap.add(now - last);
    last = now;
    size.add(e.data.length);
    received.add(1, { tipo: "central" });
  };
  setTimeout(() => ws.close(), HOLD * 1000);
}

export function pedido(data) {
  if (data.ids.length === 0) return;
  const ws = new WebSocket(`${WS}/ws/watch/order/${data.ids[(__VU - 1) % data.ids.length]}`);
  ws.onmessage = () => received.add(1, { tipo: "pedido" });
  setTimeout(() => ws.close(), HOLD * 1000);
}

export function handleSummary(data) {
  const m = data.metrics;
  const out = {
    centrais: CENTRALS,
    acompanhamentos: WATCHERS,
    retrato_intervalo_p50_ms: m.retrato_intervalo_ms?.values["med"] ?? null,
    retrato_intervalo_p99_ms: m.retrato_intervalo_ms?.values["p(99)"] ?? null,
    retrato_bytes_med: m.retrato_bytes?.values["med"] ?? null,
    mensagens: m.mensagens_recebidas?.values.count ?? 0,
    bytes_recebidos: m.data_received?.values.count ?? 0,
  };
  return { stdout: JSON.stringify(out) + "\n", "/out/k6.json": JSON.stringify(out) };
}
