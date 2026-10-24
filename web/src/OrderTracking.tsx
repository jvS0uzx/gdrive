import { useCallback, useEffect, useRef, useState } from "react";
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MapLibre } from "maplibre-gl";
import { fetchOrder, type LiveOrder, type LngLat, type OrderDetail } from "./api";
import { COLORS, EMPTY, byZoom, collection, line, panelPadding, pin, point, useCityMap } from "./cityMap";
import { formatClock } from "./format";
import { actorLabel, eventLabel, statusLabel, statusTone } from "./labels";
import { useSocket } from "./live";
import { FloatingCredit, MapSurface } from "./MapParts";
import { Link } from "./router";

interface OrderEvent {
  type: string;
  order_id: number;
  version: number;
  status: string;
  courier_id?: number;
}

type TrackMessage =
  | { type: "estado"; order: LiveOrder }
  | { type: "evento"; event: OrderEvent }
  | { type: "posicao"; courier_id: number; lat: number; lon: number; phase?: string };

interface TrailPoint {
  phase: string;
  at: LngLat;
}

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const STORE_ICON = icon('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>');
const HOME_ICON = icon('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>');

const STEPS: Record<string, number> = {
  aguardando_loja: 0,
  em_preparo: 1,
  a_caminho_da_loja: 2,
  na_loja: 2,
  em_rota: 3,
  no_cliente: 4,
  entregue: 5,
};
const STEP_COUNT = 6;
const MAX_TRAIL = 5000;
const FINAL = new Set(["entregue", "cancelado", "recusado"]);

function addTrackingLayers(map: MapLibre) {
  map.addSource("trilha", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "trilha-borda",
    type: "line",
    source: "trilha",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.ink, "line-width": byZoom(5, 7, 11) },
  });
  map.addLayer({
    id: "trilha",
    type: "line",
    source: "trilha",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "phase"], "cliente", COLORS.route, COLORS.store],
      "line-width": byZoom(2.5, 3.5, 6),
    },
  });
  map.addSource("entregador", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "entregador",
    type: "circle",
    source: "entregador",
    paint: {
      "circle-radius": 7,
      "circle-color": "#ffffff",
      "circle-stroke-color": COLORS.route,
      "circle-stroke-width": 3,
    },
  });
}

function trailFeatures(points: TrailPoint[]) {
  const legs: { phase: string; coords: LngLat[] }[] = [];
  for (const p of points) {
    const last = legs[legs.length - 1];
    if (last && last.phase === p.phase) last.coords.push(p.at);
    else legs.push({ phase: p.phase, coords: last ? [last.coords[last.coords.length - 1], p.at] : [p.at] });
  }
  return collection(legs.filter((l) => l.coords.length > 1).map((l) => line(l.coords, { phase: l.phase })));
}

export default function OrderTracking({ id }: { id: number }) {
  const { container, map, ready, error: cityError } = useCityMap(addTrackingLayers);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const version = useRef(-1);
  const requests = useRef(0);
  const trail = useRef<{ courier: number | null; points: TrailPoint[] }>({ courier: null, points: [] });
  const markers = useRef<Marker[]>([]);
  const fitted = useRef(false);

  const advance = useCallback((next: string, nextVersion: number) => {
    if (nextVersion < version.current) return;
    version.current = nextVersion;
    setStatus(next);
  }, []);

  const refresh = useCallback(() => {
    const n = ++requests.current;
    fetchOrder(id)
      .then((d) => {
        if (n !== requests.current) return;
        if (!d) {
          setMissing(true);
          return;
        }
        setLoadError(null);
        setDetail(d);
        advance(d.status, d.version);
      })
      .catch((err: Error) => {
        if (n === requests.current) setLoadError(`O pedido não carregou: ${err.message}`);
      });
  }, [id, advance]);

  const drawCourier = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const { points } = trail.current;
    const last = points[points.length - 1];
    m.getSource<GeoJSONSource>("trilha")?.setData(trailFeatures(points));
    m.getSource<GeoJSONSource>("entregador")?.setData(last ? point(last.at) : EMPTY);
  }, [map]);

  const connected = useSocket<TrackMessage>(missing ? null : `/ws/watch/order/${id}`, (message) => {
    if (message.type === "estado") {
      advance(message.order.status, message.order.version);
      return;
    }
    if (message.type === "evento") {
      if (message.event.version < version.current) return;
      advance(message.event.status, message.event.version);
      refresh();
      return;
    }
    if (message.type === "posicao") {
      const t = trail.current;
      if (t.courier !== message.courier_id) {
        t.courier = message.courier_id;
        t.points = [];
      }
      const at: LngLat = [message.lon, message.lat];
      const prev = t.points[t.points.length - 1];
      if (prev && prev.at[0] === at[0] && prev.at[1] === at[1]) return;
      t.points.push({ phase: message.phase || prev?.phase || "loja", at });
      if (t.points.length > MAX_TRAIL) t.points.splice(0, t.points.length - MAX_TRAIL);
      drawCourier();
    }
  });

  useEffect(() => {
    document.title = `Pedido #${id} · GDrive`;
    refresh();
  }, [id, refresh]);

  useEffect(() => {
    if (ready) drawCourier();
  }, [ready, drawCourier]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !detail) return;
    const store: LngLat = [detail.store.lon, detail.store.lat];
    const home: LngLat = [detail.customer.lon, detail.customer.lat];
    if (markers.current.length === 0) {
      markers.current = [
        new Marker({ element: pin(STORE_ICON, COLORS.store) }).setLngLat(store).addTo(m),
        new Marker({ element: pin(HOME_ICON, COLORS.customer) }).setLngLat(home).addTo(m),
      ];
    }
    if (!fitted.current) {
      fitted.current = true;
      const bounds = new LngLatBounds(store, store).extend(home);
      const last = trail.current.points.at(-1);
      if (last) bounds.extend(last.at);
      m.fitBounds(bounds, { padding: panelPadding(72), maxZoom: 16, duration: 0 });
    }
  }, [map, ready, detail]);

  const shown = status ?? detail?.status ?? "";
  const step = STEPS[shown];
  const deliveredAt = detail?.timeline.find((e) => e.type === "pedido_entregue")?.at;
  const timeline = detail ? [...detail.timeline].reverse() : [];

  return (
    <div className="absolute inset-0">
      <MapSurface container={container} ready={ready} />
      <aside className="absolute left-4 top-4 flex max-h-[55%] w-[min(22rem,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl border border-white/10 bg-panel/95 shadow-2xl backdrop-blur md:max-h-[calc(100%-2rem)] md:overflow-hidden">
        <header className="px-4 pb-1 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              GDrive · pedido #{id}
            </p>
            {!missing && (
              <p className="flex items-center gap-1.5 text-[11px] text-zinc-400" aria-live="polite">
                <span className={`size-2 rounded-full ${connected ? "bg-origin" : "bg-route animate-pulse"}`} />
                {connected ? "ao vivo" : "reconectando…"}
              </p>
            )}
          </div>
          {cityError && <p className="mt-1 text-xs text-target">{cityError}</p>}
          {missing ? (
            <>
              <h1 className="mt-1 text-base font-semibold text-zinc-100">Pedido não encontrado</h1>
              <p className="mt-1 text-sm text-zinc-400">Confira o número no link que você recebeu.</p>
              <Link to="/" className="mt-3 inline-block pb-3 text-sm text-route hover:underline">
                Ir para a central
              </Link>
            </>
          ) : !detail ? (
            <p className={`mt-2 pb-3 text-sm ${loadError ? "text-target" : "text-zinc-400"}`}>
              {loadError ?? "Carregando o pedido…"}
            </p>
          ) : (
            <>
              <h1 data-testid="loja" className="mt-1 text-base font-semibold text-zinc-100">
                {detail.store.name}
              </h1>
              <p
                data-testid="status"
                aria-live="polite"
                className={`mt-3 text-2xl font-semibold leading-tight ${FINAL.has(shown) ? statusTone(shown) : "text-route"}`}
              >
                {statusLabel(shown)}
              </p>
              {step !== undefined && (
                <div className="mt-3 grid grid-cols-6 gap-1" aria-hidden="true">
                  {Array.from({ length: STEP_COUNT }, (_, i) => (
                    <span key={i} className={`h-1 rounded-full ${i <= step ? "bg-route" : "bg-white/10"}`} />
                  ))}
                </div>
              )}
            </>
          )}
        </header>

        {detail && !missing && (
          <>
            <dl className="mx-4 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-zinc-500">Entregador</dt>
              <dd data-testid="entregador" className="text-zinc-200">
                {detail.courier?.name ?? "Ainda não definido"}
              </dd>
              <dt className="text-zinc-500">{deliveredAt ? "Entregue" : "Previsão"}</dt>
              <dd data-testid="previsao" className="tabular-nums text-zinc-200">
                {deliveredAt
                  ? `às ${formatClock(deliveredAt)}`
                  : detail.promised_at
                    ? `até ${formatClock(detail.promised_at)}`
                    : "—"}
              </dd>
              {detail.prep_minutes !== null && (
                <>
                  <dt className="text-zinc-500">Preparo</dt>
                  <dd className="tabular-nums text-zinc-200">{detail.prep_minutes} min</dd>
                </>
              )}
            </dl>

            <section className="mt-4 flex min-h-40 flex-1 flex-col border-t border-white/10 md:min-h-0">
              <h2 className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                Linha do tempo
              </h2>
              <ol data-testid="linha-do-tempo" className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                {timeline.map((e, i) => (
                  <li key={timeline.length - i} className="flex gap-3 py-1 text-xs">
                    <time dateTime={e.at} className="shrink-0 tabular-nums text-zinc-500">
                      {formatClock(e.at, true)}
                    </time>
                    <span className={i === 0 ? "text-zinc-100" : "text-zinc-400"}>
                      {eventLabel(e.type)}
                      <span className="text-zinc-600"> · {actorLabel(e.actor)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t border-white/10 px-4 py-2.5 text-[11px] text-zinc-400">
              {[
                ["Loja", COLORS.store],
                ["Você", COLORS.customer],
                ["Trajeto até a loja", COLORS.store],
                ["Trajeto até você", COLORS.route],
              ].map(([label, color], i) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span
                    className={i < 2 ? "size-2 rounded-full" : "h-0.5 w-3 rounded-full"}
                    style={{ background: color }}
                  />
                  {label}
                </span>
              ))}
            </footer>
          </>
        )}
      </aside>
      <FloatingCredit />
    </div>
  );
}
