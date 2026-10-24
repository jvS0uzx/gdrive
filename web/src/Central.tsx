import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, type GeoJSONSource, type Map as MapLibre, type MapMouseEvent } from "maplibre-gl";
import type { Feature } from "geojson";
import { fetchStats, type LiveOrder, type LngLat, type Point, type Stats } from "./api";
import { COLORS, EMPTY, byZoom, collection, line, point, useCityMap } from "./cityMap";
import { formatDuration, formatInt } from "./format";
import { ACTIVE_STATUSES, alertLabel, statusFill, statusLabel, statusTone } from "./labels";
import { useSocket } from "./live";
import { FloatingCredit, MapSurface } from "./MapParts";
import OrderAnalysis from "./OrderAnalysis";
import { addAlternativeLayers, addPlannedLayer, addWalkedLayers } from "./routeLayers";
import { Link } from "./router";
import SimControls, { CourierFaults } from "./SimControls";

type CourierTuple = [id: number, lon: number, lat: number, busy: number];

interface Snapshot {
  type: "snapshot";
  couriers: CourierTuple[];
  orders: LiveOrder[];
  rain?: boolean;
}

type Selection = { kind: "courier" | "order"; id: number } | null;

interface Card {
  marker: Marker;
  root: HTMLAnchorElement;
  body: HTMLDivElement;
  name: HTMLDivElement;
  badge: HTMLSpanElement;
  look: string;
}

const PICKABLE = ["entregadores", "lojas", "clientes"];
const STATS_EVERY_MS = 5000;
const NAMES_FROM_ZOOM = 14;
const CARD_BODY = "relative rounded-[5px] px-1.5 py-0.5 text-ink shadow-md shadow-black/40 transition-colors duration-500";

const alertKinds = (o: LiveOrder) => Object.keys(o.alerts ?? {});

function ageOf(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

const lngLat = (p: Point): LngLat => [p.lon, p.lat];

function createCard(id: number, onPick: (id: number) => void): Card {
  const root = document.createElement("a");
  root.href = `/pedido/${id}`;
  root.className = "block cursor-pointer hover:z-10";
  root.dataset.testid = "card-pedido";
  root.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onPick(id);
  });
  const body = document.createElement("div");
  const label = document.createElement("div");
  label.className = "mono text-[11px] font-semibold leading-4";
  label.textContent = `#${id}`;
  const name = document.createElement("div");
  name.className = "max-w-28 truncate text-[10px] font-medium leading-3";
  const badge = document.createElement("span");
  badge.className =
    "absolute -right-1.5 -top-1.5 grid size-3.5 place-items-center rounded-full bg-target text-[9px] font-bold leading-none text-ink ring-1 ring-ink";
  badge.textContent = "!";
  badge.hidden = true;
  body.append(label, name, badge);
  root.append(body);
  const marker = new Marker({ element: root, anchor: "bottom" });
  root.setAttribute("aria-label", `Pedido #${id}`);
  return { marker, root, body, name, badge, look: "" };
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
  addPlannedLayer(map);
  addAlternativeLayers(map);
  addWalkedLayers(map);
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
      "circle-color": [
        "case",
        ["==", ["get", "alert"], 1],
        COLORS.target,
        ["==", ["get", "busy"], 1],
        COLORS.busy,
        COLORS.free,
      ],
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

function selectionFeatures(selection: Selection, snapshot: Snapshot, withLine: boolean): Feature[] {
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
    features.push(point(lngLat(order.customer)));
    if (withLine) features.push(line([lngLat(order.store), lngLat(order.customer)]));
  }
  return features;
}

function Stat({ label, value, testId, dot }: { label: string; value: number | null; testId: string; dot?: string }) {
  return (
    <div className="border-line px-4 py-3 [&+&]:border-l">
      <p data-testid={testId} className="num text-[22px] font-medium leading-7 text-strong">
        {value === null ? "—" : formatInt(value)}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
        {label}
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
  const latest = useRef<Snapshot | null>(null);
  const highlight: Selection = hovered !== null ? { kind: "order", id: hovered } : selection;
  const selectedId = selection?.kind === "order" ? selection.id : null;

  const connected = useSocket<Snapshot>("/ws/watch/central", (message) => {
    if (message.type !== "snapshot") return;
    latest.current = message;
    setSnapshot(message);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    const alerting = new Set(
      snapshot.orders.filter((o) => o.courier_id !== undefined && alertKinds(o).length > 0).map((o) => o.courier_id),
    );
    m.getSource<GeoJSONSource>("entregadores")?.setData(
      collection(
        snapshot.couriers.map(([id, lon, lat, busy]) => point([lon, lat], { id, busy, alert: alerting.has(id) ? 1 : 0 })),
      ),
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
        card = createCard(o.id, (id) => setSelection({ kind: "order", id }));
        card.marker.setLngLat(at).addTo(m);
        cards.current.set(o.id, card);
      }
      card.marker.setLngLat(at).setOffset([0, -4 - index * step]);
      const selected = o.id === selectedId;
      const kinds = alertKinds(o);
      const ring = selected ? "ring-2 ring-white" : kinds.length > 0 ? "ring-2 ring-target" : "ring-1 ring-ink/70";
      const look = `${CARD_BODY} ${statusFill(o.status)} ${ring}`;
      if (card.look !== look) {
        card.body.className = look;
        card.root.dataset.status = o.status;
        card.root.dataset.selected = String(selected);
        card.root.style.zIndex = selected ? "20" : kinds.length > 0 ? "10" : "";
        card.look = look;
      }
      const alerts = kinds.join(",");
      if ((card.root.dataset.alerts ?? "") !== alerts) {
        card.root.dataset.alerts = alerts;
        card.badge.hidden = kinds.length === 0;
      }
      const name = o.store_name ?? "";
      if (card.name.textContent !== name) card.name.textContent = name;
      card.name.hidden = !zoomed || !name;
      card.root.title = [`#${o.id}`, name, statusLabel(o.status), ...kinds.map(alertLabel)].filter(Boolean).join(" · ");
      seen.add(o.id);
    }
    for (const [id, card] of cards.current) {
      if (seen.has(id)) continue;
      card.marker.remove();
      cards.current.delete(id);
    }
  }, [map, ready, snapshot, zoomed, selectedId]);

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
    m.getSource<GeoJSONSource>("selecao")?.setData(
      collection(selectionFeatures(highlight, snapshot, hovered !== null)),
    );
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
      if (!hit) return setSelection(null);
      const id = Number(hit.properties.id);
      if (hit.layer.id !== "entregadores") return setSelection({ kind: "order", id });
      const order = latest.current?.orders.find((o) => o.courier_id === id);
      setSelection(order ? { kind: "order", id: order.id } : { kind: "courier", id });
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
    const alerted = snapshot.orders
      .filter((o) => alertKinds(o).length > 0)
      .map((o) => ({ order: o, since: Math.min(...Object.values(o.alerts ?? {}).map((at) => at ?? Date.now())) }))
      .sort((a, b) => a.since - b.since);
    return { total: snapshot.couriers.length, busy, free: snapshot.couriers.length - busy, byStatus, orders, alerted };
  }, [snapshot]);

  const selectedOrder = selectedId !== null ? snapshot?.orders.find((o) => o.id === selectedId) : undefined;
  const selectedOrderCourier =
    selectedOrder?.courier_id !== undefined ? snapshot?.couriers.find((c) => c[0] === selectedOrder.courier_id) : undefined;
  const selectedCourier =
    selection?.kind === "courier" ? snapshot?.couriers.find((c) => c[0] === selection.id) : undefined;
  const courierOrder = selectedCourier ? snapshot?.orders.find((o) => o.courier_id === selectedCourier[0]) : undefined;
  const online = stats ? (stats.couriers.livre ?? 0) + (stats.couriers.ocupado ?? 0) : null;

  return (
    <div className="absolute inset-0 flex flex-col md:flex-row">
      <section className="relative h-[42dvh] shrink-0 md:order-2 md:h-auto md:min-w-0 md:flex-1" aria-label="Mapa ao vivo">
        <MapSurface container={container} ready={ready} />
        <FloatingCredit />
      </section>
      <div className="min-h-0 flex-1 overflow-y-auto md:contents">
        {selectedId !== null && (
          <OrderAnalysis
            key={selectedId}
            orderId={selectedId}
            order={selectedOrder}
            courierAt={selectedOrderCourier ? [selectedOrderCourier[1], selectedOrderCourier[2]] : undefined}
            map={map}
            ready={ready}
            onClose={() => setSelection(null)}
          />
        )}
        <aside className="dock flex flex-col border-t md:order-1 md:w-[21rem] md:shrink-0 md:overflow-y-auto md:border-r md:border-t-0">
          <header className="flex items-baseline justify-between gap-3 px-4 pb-3 pt-4">
            <h1 className="text-[15px] font-semibold tracking-tight">Central</h1>
            <p className={`text-xs ${connected ? "text-muted" : "text-route"}`} aria-live="polite">
              {connected ? "ao vivo" : "reconectando…"}
            </p>
          </header>
          {(error || !ready) && <p className={`px-4 pb-3 text-xs ${error ? "text-target" : "text-muted"}`}>{error ?? "Carregando a cidade…"}</p>}

          <section className="grid grid-cols-3 border-y border-line" aria-label="Entregadores">
            <Stat label="no mapa" value={summary?.total ?? null} testId="entregadores-no-mapa" />
            <Stat label="livres" value={summary?.free ?? null} testId="entregadores-livres" dot={COLORS.free} />
            <Stat label="ocupados" value={summary?.busy ?? null} testId="entregadores-ocupados" dot={COLORS.busy} />
          </section>
          {stats && (
            <p className="px-4 pt-2 text-xs text-faint" data-testid="cadastro">
              {formatInt(online ?? 0)} online e {formatInt(stats.couriers.offline ?? 0)} offline no cadastro
            </p>
          )}

          <section className="px-4 pt-5">
            <div className="flex items-baseline justify-between">
              <h2 className="section-title">Pedidos ativos</h2>
              <span data-testid="pedidos-ativos" className="num text-sm text-strong">
                {summary ? formatInt(summary.orders.length) : "—"}
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[13px]">
              {ACTIVE_STATUSES.map((status) => {
                const n = summary?.byStatus[status] ?? 0;
                return (
                  <div key={status} className="contents" data-testid={`status-${status}`}>
                    <dt className={`flex items-center gap-2 ${n > 0 ? "text-strong" : "text-faint"}`}>
                      <span className={`size-2 shrink-0 rounded-[2px] ${statusFill(status)} ${n > 0 ? "" : "opacity-40"}`} />
                      {statusLabel(status)}
                    </dt>
                    <dd className={`num ${n > 0 ? "text-strong" : "text-faint"}`}>{formatInt(n)}</dd>
                  </div>
                );
              })}
            </dl>
            {stats && (
              <p className="mt-2.5 text-xs text-faint">
                <span className="num">{formatInt(stats.delivered)}</span> entregues
                {stats.avg_delivery_seconds !== null && (
                  <>
                    , em média <span className="num">{formatDuration(stats.avg_delivery_seconds)}</span> cada
                  </>
                )}
              </p>
            )}
          </section>

          <section className="px-4 pt-5" data-testid="alertas">
            <div className="flex items-baseline justify-between">
              <h2 className="section-title">Alertas</h2>
              <span
                data-testid="alertas-abertos"
                className={`num text-sm ${summary?.alerted.length ? "text-target" : "text-strong"}`}
              >
                {summary ? formatInt(summary.alerted.length) : "—"}
              </span>
            </div>
            {summary && summary.alerted.length > 0 ? (
              <ul className="-mx-2 mt-1.5 max-h-36 overflow-y-auto text-[13px]" data-testid="lista-alertas">
                {summary.alerted.map(({ order, since }) => (
                  <li key={order.id}>
                    <button
                      type="button"
                      onClick={() => setSelection({ kind: "order", id: order.id })}
                      onMouseEnter={() => setHovered(order.id)}
                      onMouseLeave={() => setHovered(null)}
                      className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-raised"
                    >
                      <span className="mono w-12 shrink-0 text-xs text-faint">#{order.id}</span>
                      <span className="min-w-0 flex-1 truncate text-target">{alertKinds(order).map(alertLabel).join(", ")}</span>
                      <span className="num shrink-0 text-xs text-faint">{ageOf(since, Date.now())}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-faint">{summary ? "Nenhum alerta aberto." : ""}</p>
            )}
          </section>

          <SimControls liveRain={snapshot?.rain} />

          {selectedCourier && (
            <section className="mx-4 mt-5 rounded-md bg-raised px-3 py-2.5" data-testid="selecao">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[13px] font-medium">
                  Entregador <span className="mono">#{selectedCourier[0]}</span>
                  <span className="ml-2 font-normal text-muted">{selectedCourier[3] === 1 ? "ocupado" : "livre"}</span>
                </p>
                <button
                  type="button"
                  onClick={() => setSelection(null)}
                  className="rounded px-1 text-lg leading-none text-faint transition-colors hover:text-strong"
                  aria-label="Limpar seleção"
                >
                  ×
                </button>
              </div>
              {courierOrder && (
                <button
                  type="button"
                  onClick={() => setSelection({ kind: "order", id: courierOrder.id })}
                  className="link mt-1 text-xs"
                >
                  Ver o pedido {courierOrder.id}
                </button>
              )}
              <div className="mt-2.5">
                <CourierFaults courierId={selectedCourier[0]} />
              </div>
            </section>
          )}

          <section className="mt-5 flex min-h-48 flex-1 flex-col border-t border-line md:min-h-40">
            <h2 className="section-title px-4 pb-1 pt-3">Últimos pedidos</h2>
            {summary && summary.orders.length > 0 ? (
              <ul className="min-h-0 flex-1 overflow-y-auto pb-2" data-testid="lista-pedidos">
                {summary.orders.map((o) => (
                  <li key={o.id}>
                    <Link
                      to={`/pedido/${o.id}`}
                      onMouseEnter={() => setHovered(o.id)}
                      onMouseLeave={() => setHovered(null)}
                      className={`flex items-baseline gap-2 px-4 py-1.5 text-[13px] transition-colors hover:bg-raised ${
                        selection?.kind === "order" && selection.id === o.id ? "bg-raised" : ""
                      }`}
                    >
                      <span className="mono w-12 shrink-0 text-xs text-faint">#{o.id}</span>
                      <span className="min-w-0 flex-1 truncate">{o.store_name ?? "Loja"}</span>
                      <span className={`shrink-0 text-xs ${statusTone(o.status)}`}>{statusLabel(o.status)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-2 text-xs text-faint">{summary ? "Nenhum pedido ativo agora." : "Aguardando dados ao vivo…"}</p>
            )}
          </section>

          <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[11px] text-faint">
            {[
              ["livre", COLORS.free],
              ["ocupado", COLORS.busy],
              ["com alerta", COLORS.target],
              ["loja", COLORS.storeDot],
            ].map(([label, color]) => (
              <span key={label} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: color }} />
                {label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full border-[1.5px]" style={{ borderColor: COLORS.customerDot }} />
              cliente
            </span>
            <span className="flex items-center gap-1.5">
              <span className="mono rounded-[3px] bg-muted px-1 text-[9px] font-semibold leading-3 text-ink">#2601</span>
              pedido, na cor da etapa
            </span>
          </footer>
        </aside>
      </div>
    </div>
  );
}
