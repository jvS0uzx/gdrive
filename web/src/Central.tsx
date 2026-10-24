import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, type GeoJSONSource, type Map as MapLibre, type MapMouseEvent } from "maplibre-gl";
import type { Feature } from "geojson";
import { fetchStats, type LiveOrder, type LngLat, type Point, type Stats } from "./api";
import { COLORS, EMPTY, byZoom, collection, line, point, useCityMap } from "./cityMap";
import { formatDuration, formatInt } from "./format";
import { ACTIVE_STATUSES, statusFill, statusLabel, statusTone } from "./labels";
import { useSocket } from "./live";
import { FloatingCredit, MapSurface } from "./MapParts";
import { Link, navigate } from "./router";

type CourierTuple = [id: number, lon: number, lat: number, busy: number];

interface Snapshot {
  type: "snapshot";
  couriers: CourierTuple[];
  orders: LiveOrder[];
}

type Selection = { kind: "courier" | "order"; id: number } | null;

interface Card {
  marker: Marker;
  root: HTMLAnchorElement;
  body: HTMLDivElement;
  name: HTMLDivElement;
  status: string;
}

const PICKABLE = ["entregadores", "lojas", "clientes"];
const STATS_EVERY_MS = 5000;
const NAMES_FROM_ZOOM = 14;
const CARD_BODY = "rounded-md px-1.5 py-0.5 text-ink shadow-lg ring-1 ring-ink/70 transition-colors duration-500";

const lngLat = (p: Point): LngLat => [p.lon, p.lat];

function createCard(id: number): Card {
  const root = document.createElement("a");
  root.href = `/pedido/${id}`;
  root.className = "block cursor-pointer hover:z-10";
  root.dataset.testid = "card-pedido";
  root.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(`/pedido/${id}`);
  });
  const body = document.createElement("div");
  const label = document.createElement("div");
  label.className = "text-[11px] font-bold leading-4 tabular-nums";
  label.textContent = `#${id}`;
  const name = document.createElement("div");
  name.className = "max-w-28 truncate text-[10px] font-medium leading-3";
  body.append(label, name);
  root.append(body);
  const marker = new Marker({ element: root, anchor: "bottom" });
  root.setAttribute("aria-label", `Pedido #${id}`);
  return { marker, root, body, name, status: "" };
}

function cardAnchor(order: LiveOrder, couriers: Map<number, LngLat>): LngLat | null {
  if (order.status === "em_rota" && order.courier_id !== undefined) {
    const at = couriers.get(order.courier_id);
    if (at) return at;
  }
  if (order.status === "no_cliente" && order.customer) return lngLat(order.customer);
  return order.store ? lngLat(order.store) : null;
}

function addLiveLayers(map: MapLibre) {
  for (const id of ["lojas", "clientes", "entregadores", "selecao"]) {
    map.addSource(id, { type: "geojson", data: EMPTY });
  }
  map.addLayer({
    id: "selecao-linha",
    type: "line",
    source: "selecao",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round" },
    paint: { "line-color": COLORS.highlight, "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.7 },
  });
  map.addLayer({
    id: "lojas",
    type: "circle",
    source: "lojas",
    paint: {
      "circle-radius": byZoom(2, 3.5, 5.5),
      "circle-color": COLORS.storeDot,
      "circle-stroke-color": COLORS.ink,
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "clientes",
    type: "circle",
    source: "clientes",
    paint: {
      "circle-radius": byZoom(2, 3.5, 5.5),
      "circle-color": "rgba(0, 0, 0, 0)",
      "circle-stroke-color": COLORS.customerDot,
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "entregadores",
    type: "circle",
    source: "entregadores",
    paint: {
      "circle-radius": byZoom(3, 5, 8),
      "circle-color": ["case", ["==", ["get", "busy"], 1], COLORS.busy, COLORS.free],
      "circle-stroke-color": COLORS.ink,
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "selecao",
    type: "circle",
    source: "selecao",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": byZoom(7, 9, 13),
      "circle-color": "rgba(0, 0, 0, 0)",
      "circle-stroke-color": COLORS.highlight,
      "circle-stroke-width": 2,
    },
  });
}

function selectionFeatures(selection: Selection, snapshot: Snapshot): Feature[] {
  if (!selection) return [];
  const courierAt = (id: number | undefined) => {
    const c = snapshot.couriers.find((c) => c[0] === id);
    return c ? [point([c[1], c[2]])] : [];
  };
  if (selection.kind === "courier") return courierAt(selection.id);
  const order = snapshot.orders.find((o) => o.id === selection.id);
  if (!order?.store) return [];
  const features: Feature[] = [point(lngLat(order.store)), ...courierAt(order.courier_id)];
  if (order.customer) {
    features.push(point(lngLat(order.customer)), line([lngLat(order.store), lngLat(order.customer)]));
  }
  return features;
}

function Counter({ label, value, testId, dot }: { label: string; value: number | null; testId: string; dot?: string }) {
  return (
    <div className="rounded-lg border border-white/10 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        {dot && <span className="size-2 rounded-full" style={{ background: dot }} />}
        {label}
      </p>
      <p data-testid={testId} className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-100">
        {value === null ? "—" : formatInt(value)}
      </p>
    </div>
  );
}

export default function Central() {
  const { container, map, ready, error } = useCityMap(addLiveLayers);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const cards = useRef(new Map<number, Card>());
  const highlight: Selection = hovered !== null ? { kind: "order", id: hovered } : selection;

  const connected = useSocket<Snapshot>("/ws/watch/central", (message) => {
    if (message.type === "snapshot") setSnapshot(message);
  });

  useEffect(() => {
    document.title = "Central · GDrive";
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchStats()
        .then((s) => alive && setStats(s))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, STATS_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !snapshot) return;
    const placed = snapshot.orders.filter((o) => o.store);
    m.getSource<GeoJSONSource>("entregadores")?.setData(
      collection(snapshot.couriers.map(([id, lon, lat, busy]) => point([lon, lat], { id, busy }))),
    );
    m.getSource<GeoJSONSource>("lojas")?.setData(collection(placed.map((o) => point(lngLat(o.store!), { id: o.id }))));
    m.getSource<GeoJSONSource>("clientes")?.setData(
      collection(placed.filter((o) => o.customer).map((o) => point(lngLat(o.customer!), { id: o.id }))),
    );
  }, [map, ready, snapshot]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !snapshot) return;
    const couriers = new Map(snapshot.couriers.map((c): [number, LngLat] => [c[0], [c[1], c[2]]]));
    const stacks = new Map<string, number>();
    const step = zoomed ? 34 : 22;
    const seen = new Set<number>();
    for (const o of [...snapshot.orders].sort((a, b) => a.id - b.id)) {
      const at = cardAnchor(o, couriers);
      if (!at) continue;
      const key = `${at[0].toFixed(5)},${at[1].toFixed(5)}`;
      const index = stacks.get(key) ?? 0;
      stacks.set(key, index + 1);
      let card = cards.current.get(o.id);
      if (!card) {
        card = createCard(o.id);
        card.marker.setLngLat(at).addTo(m);
        cards.current.set(o.id, card);
      }
      card.marker.setLngLat(at).setOffset([0, -4 - index * step]);
      if (card.status !== o.status) {
        card.body.className = `${CARD_BODY} ${statusFill(o.status)}`;
        card.root.dataset.status = o.status;
        card.status = o.status;
      }
      const name = o.store_name ?? "";
      if (card.name.textContent !== name) card.name.textContent = name;
      card.name.hidden = !zoomed || !name;
      card.root.title = [`#${o.id}`, name, statusLabel(o.status)].filter(Boolean).join(" · ");
      seen.add(o.id);
    }
    for (const [id, card] of cards.current) {
      if (seen.has(id)) continue;
      card.marker.remove();
      cards.current.delete(id);
    }
  }, [map, ready, snapshot, zoomed]);

  useEffect(() => {
    const placed = cards.current;
    return () => {
      for (const card of placed.values()) card.marker.remove();
      placed.clear();
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const onZoom = () => setZoomed(m.getZoom() >= NAMES_FROM_ZOOM);
    onZoom();
    m.on("zoom", onZoom);
    return () => {
      m.off("zoom", onZoom);
    };
  }, [map, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !snapshot) return;
    m.getSource<GeoJSONSource>("selecao")?.setData(collection(selectionFeatures(highlight, snapshot)));
  }, [map, ready, snapshot, highlight?.kind, highlight?.id]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const hitAt = (e: MapMouseEvent) => {
      const { x, y } = e.point;
      return m.queryRenderedFeatures(
        [
          [x - 6, y - 6],
          [x + 6, y + 6],
        ],
        { layers: PICKABLE },
      )[0];
    };
    const onClick = (e: MapMouseEvent) => {
      const hit = hitAt(e);
      setSelection(
        hit ? { kind: hit.layer.id === "entregadores" ? "courier" : "order", id: Number(hit.properties.id) } : null,
      );
    };
    const onMove = (e: MapMouseEvent) => {
      m.getCanvas().style.cursor = hitAt(e) ? "pointer" : "";
    };
    m.on("click", onClick);
    m.on("mousemove", onMove);
    return () => {
      m.off("click", onClick);
      m.off("mousemove", onMove);
    };
  }, [map, ready]);

  const summary = useMemo(() => {
    if (!snapshot) return null;
    const busy = snapshot.couriers.filter((c) => c[3] === 1).length;
    const byStatus: Record<string, number> = {};
    for (const o of snapshot.orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    const orders = [...snapshot.orders].sort((a, b) => b.id - a.id);
    return { total: snapshot.couriers.length, busy, free: snapshot.couriers.length - busy, byStatus, orders };
  }, [snapshot]);

  const selectedOrder =
    selection?.kind === "order" ? snapshot?.orders.find((o) => o.id === selection.id) : undefined;
  const selectedCourier =
    selection?.kind === "courier" ? snapshot?.couriers.find((c) => c[0] === selection.id) : undefined;
  const courierOrder = selectedCourier ? snapshot?.orders.find((o) => o.courier_id === selectedCourier[0]) : undefined;
  const online = stats ? (stats.couriers.livre ?? 0) + (stats.couriers.ocupado ?? 0) : null;

  return (
    <div className="absolute inset-0">
      <MapSurface container={container} ready={ready} />
      <aside className="absolute left-4 top-4 flex max-h-[55%] w-[min(22rem,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl border border-white/10 bg-panel/95 shadow-2xl backdrop-blur md:max-h-[calc(100%-2rem)] md:overflow-hidden">
        <header className="px-4 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · central</p>
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-400" aria-live="polite">
              <span className={`size-2 rounded-full ${connected ? "bg-origin" : "bg-route animate-pulse"}`} />
              {connected ? "ao vivo" : "reconectando…"}
            </p>
          </div>
          <h1 className="mt-1 text-base font-semibold text-zinc-100">Operação ao vivo em Salvador</h1>
          {error ? (
            <p className="mt-1 text-sm text-target">{error}</p>
          ) : !ready ? (
            <p className="mt-1 text-xs text-zinc-400">Carregando a cidade…</p>
          ) : null}
        </header>

        <section className="px-4 pt-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Entregadores</h2>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Counter label="No mapa" value={summary?.total ?? null} testId="entregadores-no-mapa" />
            <Counter label="Livres" value={summary?.free ?? null} testId="entregadores-livres" dot={COLORS.free} />
            <Counter label="Ocupados" value={summary?.busy ?? null} testId="entregadores-ocupados" dot={COLORS.busy} />
          </div>
          {stats && (
            <p className="mt-2 text-[11px] text-zinc-500" data-testid="cadastro">
              Cadastro: {formatInt(online ?? 0)} online · {formatInt(stats.couriers.offline ?? 0)} offline
            </p>
          )}
        </section>

        <section className="px-4 pt-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Pedidos ativos</h2>
            <span data-testid="pedidos-ativos" className="text-sm font-semibold tabular-nums text-zinc-100">
              {summary ? formatInt(summary.orders.length) : "—"}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            {ACTIVE_STATUSES.map((status) => {
              const n = summary?.byStatus[status] ?? 0;
              return (
                <div key={status} className="contents" data-testid={`status-${status}`}>
                  <dt className={`flex items-center gap-2 ${n > 0 ? statusTone(status) : "text-zinc-500"}`}>
                    <span className={`h-2.5 w-3.5 shrink-0 rounded-sm ${statusFill(status)}`} />
                    {statusLabel(status)}
                  </dt>
                  <dd className={`tabular-nums ${n > 0 ? "text-zinc-100" : "text-zinc-600"}`}>{formatInt(n)}</dd>
                </div>
              );
            })}
          </dl>
          {stats && (
            <p className="mt-2 text-[11px] text-zinc-500">
              {formatInt(stats.delivered)} entregues
              {stats.avg_delivery_seconds !== null &&
                ` · tempo médio de entrega ${formatDuration(stats.avg_delivery_seconds)}`}
            </p>
          )}
        </section>

        {(selectedOrder || selectedCourier) && (
          <section className="mx-4 mt-4 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs" data-testid="selecao">
            <div className="flex items-start justify-between gap-3">
              {selectedOrder ? (
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-100">{selectedOrder.store_name ?? "Loja"}</p>
                  <p className={statusTone(selectedOrder.status)}>
                    Pedido #{selectedOrder.id} · {statusLabel(selectedOrder.status)}
                  </p>
                  {selectedOrder.courier_id && <p className="text-zinc-400">Entregador #{selectedOrder.courier_id}</p>}
                  <Link to={`/pedido/${selectedOrder.id}`} className="mt-1 inline-block text-route hover:underline">
                    Acompanhar pedido →
                  </Link>
                </div>
              ) : selectedCourier ? (
                <div className="min-w-0">
                  <p className="text-sm text-zinc-100">Entregador #{selectedCourier[0]}</p>
                  <p className="text-zinc-400">{selectedCourier[3] === 1 ? "Ocupado" : "Livre"}</p>
                  {courierOrder && (
                    <Link to={`/pedido/${courierOrder.id}`} className="mt-1 inline-block text-route hover:underline">
                      Pedido #{courierOrder.id} · {courierOrder.store_name ?? "Loja"} →
                    </Link>
                  )}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setSelection(null)}
                className="text-zinc-500 hover:text-zinc-200"
                aria-label="Limpar seleção"
              >
                ×
              </button>
            </div>
          </section>
        )}

        <section className="mt-4 flex min-h-40 flex-1 flex-col border-t border-white/10 md:min-h-0">
          {summary && summary.orders.length > 0 ? (
            <ul className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="lista-pedidos">
              {summary.orders.map((o) => (
                <li key={o.id}>
                  <Link
                    to={`/pedido/${o.id}`}
                    onMouseEnter={() => setHovered(o.id)}
                    onMouseLeave={() => setHovered(null)}
                    className={`flex items-baseline justify-between gap-3 px-4 py-1.5 text-xs hover:bg-white/5 ${
                      selection?.kind === "order" && selection.id === o.id ? "bg-white/5" : ""
                    }`}
                  >
                    <span className="min-w-0 truncate text-zinc-200">
                      <span className="tabular-nums text-zinc-500">#{o.id}</span> {o.store_name ?? "Loja"}
                    </span>
                    <span className={`shrink-0 ${statusTone(o.status)}`}>{statusLabel(o.status)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-xs text-zinc-500">
              {summary ? "Nenhum pedido ativo agora." : "Aguardando dados ao vivo…"}
            </p>
          )}
        </section>

        <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t border-white/10 px-4 py-2.5 text-[11px] text-zinc-400">
          {[
            ["Entregador livre", COLORS.free],
            ["Entregador ocupado", COLORS.busy],
            ["Loja", COLORS.storeDot],
          ].map(([label, color]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full border-[1.5px]" style={{ borderColor: COLORS.customerDot }} />
            Cliente
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded-sm bg-zinc-300 px-1 text-[9px] font-bold leading-3 text-ink">#ID</span>
            Pedido, na cor do status
          </span>
        </footer>
      </aside>
      <FloatingCredit />
    </div>
  );
}
