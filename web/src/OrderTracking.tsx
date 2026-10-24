import { useCallback, useEffect, useRef, useState } from "react";
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MapLibre } from "maplibre-gl";
import { fetchJourney, fetchOrder, type Journey, type Leg, type LiveOrder, type LngLat, type OrderDetail } from "./api";
import { COLORS, EMPTY, pin, point, useCityMap } from "./cityMap";
import { formatClock } from "./format";
import { actorLabel, eventLabel, statusFill, statusLabel, statusTone } from "./labels";
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
    document.title = `Pedido #${id} · Gdrive`;
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
      m.fitBounds(bounds, { padding: 64, maxZoom: 16, duration: 0 });
    }
  }, [map, ready, detail]);

  const shown = status ?? detail?.status ?? "";
  const step = STEPS[shown];
  const deliveredAt = detail?.timeline.find((e) => e.type === "pedido_entregue")?.at;
  const timeline = detail ? [...detail.timeline].reverse() : [];

  const fill = shown === "entregue" ? "bg-origin" : statusFill(shown);

  return (
    <div className="absolute inset-0 flex flex-col md:flex-row">
      <section className="relative h-[45dvh] shrink-0 md:order-2 md:h-auto md:min-w-0 md:flex-1" aria-label="Mapa do pedido">
        <MapSurface container={container} ready={ready} />
        <FloatingCredit />
      </section>
      <aside className="dock flex min-h-0 flex-1 flex-col overflow-y-auto border-t md:order-1 md:w-[22rem] md:flex-none md:border-r md:border-t-0">
        <header className="px-5 pb-4 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs text-muted">
              Pedido <span className="mono">#{id}</span>
            </p>
            {!missing && (
              <p className={`text-xs ${connected ? "text-muted" : "text-route"}`} aria-live="polite">
                {connected ? "ao vivo" : "reconectando…"}
              </p>
            )}
          </div>
          {cityError && <p className="mt-1 text-xs text-target">{cityError}</p>}
          {missing ? (
            <>
              <h1 className="mt-2 text-[17px] font-semibold tracking-tight">Pedido não encontrado</h1>
              <p className="mt-1 text-sm text-muted">Confira o número no link que você recebeu.</p>
              <Link to="/" className="link mt-3 inline-block text-sm">
                Voltar para a central
              </Link>
            </>
          ) : !detail ? (
            <p className={`mt-2 text-sm ${loadError ? "text-target" : "text-muted"}`}>{loadError ?? "Carregando o pedido…"}</p>
          ) : (
            <>
              <h1 data-testid="loja" className="mt-1 text-[17px] font-semibold tracking-tight">
                {detail.store.name}
              </h1>
              <p
                data-testid="status"
                aria-live="polite"
                className={`mt-4 text-[26px] font-semibold leading-tight tracking-tight ${statusTone(shown)}`}
              >
                {statusLabel(shown)}
              </p>
              {step !== undefined && (
                <div className="mt-3 grid grid-cols-6 gap-1" aria-hidden="true">
                  {Array.from({ length: STEP_COUNT }, (_, i) => (
                    <span
                      key={i}
                      className={`h-1 rounded-full transition-colors duration-500 ${i <= step ? fill : "bg-raised"}`}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </header>

        {detail && !missing && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-y border-line px-5 py-4 text-[13px]">
              <dt className="text-muted">Entregador</dt>
              <dd data-testid="entregador">{detail.courier?.name ?? "ainda não definido"}</dd>
              <dt className="text-muted">{deliveredAt ? "Entregue" : "Previsão"}</dt>
              <dd data-testid="previsao">
                {deliveredAt ? (
                  <>
                    às <span className="mono">{formatClock(deliveredAt)}</span>
                  </>
                ) : detail.promised_at ? (
                  <>
                    até <span className="mono">{formatClock(detail.promised_at)}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
              {detail.prep_minutes !== null && (
                <>
                  <dt className="text-muted">Preparo</dt>
                  <dd className="num">{detail.prep_minutes} min</dd>
                </>
              )}
            </dl>

            <section className="flex min-h-48 flex-1 flex-col md:min-h-0">
              <h2 className="section-title px-5 pt-4">Linha do tempo</h2>
              <ol data-testid="linha-do-tempo" className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
                {timeline.map((e, i) => (
                  <li key={timeline.length - i} className="flex gap-3 py-1.5 text-[13px]">
                    <time dateTime={e.at} className="mono shrink-0 pt-px text-xs text-faint">
                      {formatClock(e.at, true)}
                    </time>
                    <span className={i === 0 ? "text-strong" : "text-muted"}>
                      {eventLabel(e.type)}
                      <span className="ml-1.5 text-xs text-faint">{actorLabel(e.actor)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-5 py-3 text-[11px] text-faint">
              {[
                ["loja", COLORS.store],
                ["você", COLORS.customer],
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
                  {leg === "loja" ? "até a loja" : "até você"}
                </span>
              ))}
              <span>tracejado é o previsto</span>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
