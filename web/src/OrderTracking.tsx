import { useCallback, useEffect, useRef, useState } from "react";
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MapLibre } from "maplibre-gl";
import { fetchJourney, fetchOrder, type Journey, type Leg, type LiveOrder, type LngLat, type OrderDetail } from "./api";
import { COLORS, EMPTY, panelPadding, pin, point, useCityMap } from "./cityMap";
import { formatClock } from "./format";
import { actorLabel, eventLabel, statusLabel, statusTone } from "./labels";
import { useSocket } from "./live";
import { FloatingCredit, LineSample, MapSurface } from "./MapParts";
import { LEG_COLORS, addPlannedLayer, addWalkedLayers, journeyFeatures, lastPosition } from "./routeLayers";
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
const JOURNEY_EVERY_MS = 5000;
const FINAL = new Set(["entregue", "cancelado", "recusado"]);

function addTrackingLayers(map: MapLibre) {
  addPlannedLayer(map);
  addWalkedLayers(map);
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

export default function OrderTracking({ id }: { id: number }) {
  const { container, map, ready, error: cityError } = useCityMap(addTrackingLayers);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const version = useRef(-1);
  const requests = useRef(0);
  const journey = useRef<Journey | null>(null);
  const courierAt = useRef<LngLat | null>(null);
  const journeys = useRef(0);
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
    const at = courierAt.current ?? lastPosition(journey.current);
    m.getSource<GeoJSONSource>("jornada")?.setData(journeyFeatures(journey.current));
    m.getSource<GeoJSONSource>("entregador")?.setData(at ? point(at) : EMPTY);
  }, [map]);

  const loadJourney = useCallback(() => {
    const n = ++journeys.current;
    fetchJourney(id)
      .then((j) => {
        if (n !== journeys.current) return;
        journey.current = j;
        drawCourier();
      })
      .catch(() => undefined);
  }, [id, drawCourier]);

  const connected = useSocket<TrackMessage>(missing ? null : `/ws/watch/order/${id}`, (message) => {
    if (message.type === "estado") {
      advance(message.order.status, message.order.version);
      return;
    }
    if (message.type === "evento") {
      if (message.event.version < version.current) return;
      advance(message.event.status, message.event.version);
      refresh();
      loadJourney();
      return;
    }
    if (message.type === "posicao") {
      courierAt.current = [message.lon, message.lat];
      const leg = message.phase as Leg;
      const track = journey.current?.track[leg];
      if (track) track.push([message.lon, message.lat, Date.now()]);
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

  const finished = FINAL.has(status ?? detail?.status ?? "");

  useEffect(() => {
    if (missing) return;
    loadJourney();
    if (finished) return;
    const timer = window.setInterval(loadJourney, JOURNEY_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [missing, finished, loadJourney]);

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
      const last = courierAt.current ?? lastPosition(journey.current);
      if (last) bounds.extend(last);
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
              ].map(([label, color]) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  {label}
                </span>
              ))}
              {(["loja", "cliente"] as const).map((leg) => (
                <span key={leg} className="flex items-center gap-1.5">
                  <LineSample color={LEG_COLORS[leg]} dashed />
                  <LineSample color={LEG_COLORS[leg]} />
                  {leg === "loja" ? "Até a loja" : "Até você"}
                </span>
              ))}
              <span className="w-full text-zinc-500">Tracejado é o caminho previsto; sólido, o que o entregador já fez.</span>
            </footer>
          </>
        )}
      </aside>
      <FloatingCredit />
    </div>
  );
}
