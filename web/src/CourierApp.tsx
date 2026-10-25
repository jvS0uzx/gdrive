import { useCallback, useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl";
import {
  acceptOffer,
  courierOffline,
  courierOnline,
  declineOffer,
  deliverOrder,
  fetchCourier,
  fetchRoute,
  pickupOrder,
  type CourierView,
  type Leg,
  type LngLat,
  type Point,
} from "./api";
import { COLORS, EMPTY, collection, line, metersBetween, point, useCityMap } from "./cityMap";
import { formatDistance, formatDuration } from "./format";
import { MapSurface, OsmCredit } from "./MapParts";
import { LEG_COLORS } from "./routeLayers";
import { Link } from "./router";

const POLL_MS = 1500;
const TICK_MS = 1000;
const TICK_SECONDS = TICK_MS / 1000;
const DEFAULT_SPEED = 8;
const FOLLOW_ZOOM = 15;
const OFFER_SECONDS = 30;
const MAX_BACKOFF_MS = 10_000;
const FALLBACK_METERS_PER_SECOND = 8;

interface Drive {
  key: string;
  leg: Leg;
  coords: LngLat[];
  cumulative: number[];
  elapsed: number;
}

const RIDE_LABELS: Record<string, string> = {
  a_caminho_da_loja: "Indo para a loja",
  na_loja: "Na loja",
  em_rota: "Levando ao cliente",
  no_cliente: "No endereço do cliente",
};

const STATUS_CHIPS: Record<CourierView["status"], { label: string; color: string }> = {
  offline: { label: "Offline", color: "var(--color-faint)" },
  livre: { label: "Livre", color: COLORS.free },
  ocupado: { label: "Em entrega", color: COLORS.busy },
};

const lngLat = (p: Point): LngLat => [p.lon, p.lat];

function speedFromQuery(): number {
  const raw = Number(new URLSearchParams(window.location.search).get("velocidade"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : DEFAULT_SPEED;
}

function storageKey(id: number): string {
  return `gdrive.entregador.${id}.posicao`;
}

function loadPosition(id: number): LngLat | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null");
    if (Array.isArray(saved) && saved.length === 2 && saved.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return [saved[0], saved[1]];
    }
  } catch {
    return null;
  }
  return null;
}

function savePosition(id: number, at: LngLat) {
  try {
    sessionStorage.setItem(storageKey(id), JSON.stringify(at));
  } catch {
    return;
  }
}

function positionAt(drive: Drive, elapsed: number): LngLat {
  const times = drive.cumulative;
  const coords = drive.coords;
  const last = coords.length - 1;
  if (last === 0 || elapsed >= times[last]) return coords[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= elapsed) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const f = span > 0 ? (elapsed - times[lo]) / span : 1;
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * f, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * f];
}

function straight(from: LngLat, to: LngLat): Pick<Drive, "coords" | "cumulative"> {
  return { coords: [from, to], cumulative: [0, Math.max(1, metersBetween(from, to) / FALLBACK_METERS_PER_SECOND)] };
}

function socketUrl(path: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${path}`;
}

function useCourierSocket(id: number, active: boolean, onOpen: (ws: WebSocket) => void) {
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const opened = useRef(onOpen);

  useEffect(() => {
    opened.current = onOpen;
  });

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer = 0;
    let attempt = 0;
    let current: WebSocket | null = null;

    const open = () => {
      const ws = new WebSocket(socketUrl(`/ws/courier?id=${id}`));
      current = ws;
      ws.onopen = () => {
        attempt = 0;
        socket.current = ws;
        setConnected(true);
        opened.current(ws);
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt += 1;
        timer = window.setTimeout(open, delay);
      };
    };

    open();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      current?.close();
      socket.current = null;
      setConnected(false);
    };
  }, [id, active]);

  return { socket, connected };
}

function addCourierLayers(map: MapLibre) {
  const round = { "line-cap": "round", "line-join": "round" } as const;
  map.addSource("rota-entregador", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "rota-entregador-borda",
    type: "line",
    source: "rota-entregador",
    layout: round,
    paint: { "line-color": COLORS.ink, "line-width": 8 },
  });
  map.addLayer({
    id: "rota-entregador",
    type: "line",
    source: "rota-entregador",
    layout: round,
    paint: {
      "line-color": ["match", ["get", "leg"], "cliente", LEG_COLORS.cliente, LEG_COLORS.loja],
      "line-width": 4.5,
    },
  });
  map.addSource("destinos", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "destinos",
    type: "circle",
    source: "destinos",
    paint: {
      "circle-radius": 7,
      "circle-color": ["match", ["get", "kind"], "cliente", COLORS.customer, COLORS.store],
      "circle-stroke-color": COLORS.ink,
      "circle-stroke-width": 2,
    },
  });
  map.addSource("eu", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "eu",
    type: "circle",
    source: "eu",
    paint: {
      "circle-radius": 8,
      "circle-color": "#ffffff",
      "circle-stroke-color": COLORS.route,
      "circle-stroke-width": 3,
    },
  });
}

const big = "btn h-12 w-full rounded-lg text-[15px]";
const bigPrimary = `${big} btn-primary`;

const toggle =
  "switch";

const frame =
  "flex h-full w-full flex-col overflow-hidden bg-panel sm:w-[24.5rem] sm:rounded-[2.25rem] sm:border-[7px] sm:border-raised sm:ring-1 sm:ring-line";

export default function CourierApp({ id }: { id: number }) {
  const { container, map, ready, error: cityError } = useCityMap(addCourierLayers);
  const [courier, setCourier] = useState<CourierView | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autopilot, setAutopilot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [routeKey, setRouteKey] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [speed] = useState(speedFromQuery);
  const position = useRef<LngLat | null>(null);
  const shown = useRef<LngLat | null>(null);
  const drive = useRef<Drive | null>(null);
  const autopilotOn = useRef(autopilot);
  const animation = useRef(0);
  const centered = useRef(false);
  const requests = useRef(0);

  const refresh = useCallback(() => {
    const n = ++requests.current;
    return fetchCourier(id)
      .then((c) => {
        if (n !== requests.current) return;
        if (!c) {
          setMissing(true);
          return;
        }
        setLoadError(null);
        if (!position.current) position.current = loadPosition(id) ?? lngLat(c.home);
        setCourier(c);
      })
      .catch((err: Error) => {
        if (n === requests.current) setLoadError(`O entregador não carregou: ${err.message}`);
      });
  }, [id]);

  useEffect(() => {
    if (missing) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [missing, refresh]);

  useEffect(() => {
    document.title = courier ? `${courier.name} · Gdrive` : "Entregador · Gdrive";
  }, [courier?.name]);

  useEffect(() => {
    autopilotOn.current = autopilot;
  }, [autopilot]);

  const simOwned = courier !== null && !courier.human && courier.status !== "offline";
  const online = courier !== null && courier.human && courier.status !== "offline";
  const ride = online ? courier.order : null;
  const offer = online && !ride ? courier.offer : null;
  const leg: Leg | null = ride?.status === "a_caminho_da_loja" ? "loja" : ride?.status === "em_rota" ? "cliente" : null;
  const legKey = ride && leg ? `${ride.id}:${leg}` : null;
  const target = ride && leg ? (leg === "loja" ? ride.store : ride.customer) : null;
  const targetLon = target?.lon;
  const targetLat = target?.lat;

  const send = useCallback((ws: WebSocket) => {
    const at = position.current;
    if (at && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ lat: at[1], lon: at[0] }));
  }, []);

  const { socket, connected } = useCourierSocket(id, online, send);

  const placeDot = useCallback(
    (at: LngLat) => {
      const m = map.current;
      if (!m || !ready) return;
      shown.current = at;
      m.getSource<GeoJSONSource>("eu")?.setData(point(at));
      m.jumpTo({ center: at });
    },
    [map, ready],
  );

  const moveTo = useCallback(
    (next: LngLat) => {
      position.current = next;
      const from = shown.current;
      cancelAnimationFrame(animation.current);
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!from || still) {
        placeDot(next);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const f = Math.min(1, (now - start) / (TICK_MS * 0.9));
        placeDot([from[0] + (next[0] - from[0]) * f, from[1] + (next[1] - from[1]) * f]);
        if (f < 1) animation.current = requestAnimationFrame(step);
      };
      animation.current = requestAnimationFrame(step);
    },
    [placeDot],
  );

  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  const drawRoute = useCallback(() => {
    const d = drive.current;
    map.current
      ?.getSource<GeoJSONSource>("rota-entregador")
      ?.setData(d ? collection([line(d.coords, { leg: d.leg })]) : EMPTY);
  }, [map]);

  const hasCourier = courier !== null;

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    for (const handler of [m.dragPan, m.scrollZoom, m.boxZoom, m.dragRotate, m.keyboard, m.doubleClickZoom, m.touchZoomRotate, m.touchPitch]) {
      handler.disable();
    }
    drawRoute();
    const at = position.current;
    if (!at || centered.current) return;
    centered.current = true;
    m.jumpTo({ center: at, zoom: FOLLOW_ZOOM });
    placeDot(at);
  }, [map, ready, hasCourier, drawRoute, placeDot]);

  useEffect(() => {
    if (!legKey || !leg || targetLon === undefined || targetLat === undefined) {
      drive.current = null;
      setRouteKey(null);
      drawRoute();
      return;
    }
    if (drive.current?.key === legKey) return;
    const from = position.current;
    if (!from) return;
    const to: LngLat = [targetLon, targetLat];
    const controller = new AbortController();
    fetchRoute(from, to, false, controller.signal)
      .then((r) =>
        r.path.coordinates.length > 0 && r.cumulative_seconds.length === r.path.coordinates.length
          ? { coords: r.path.coordinates, cumulative: r.cumulative_seconds }
          : straight(from, to),
      )
      .catch(() => (controller.signal.aborted ? null : straight(from, to)))
      .then((path) => {
        if (!path || controller.signal.aborted) return;
        drive.current = { key: legKey, leg, ...path, elapsed: 0 };
        setRouteKey(legKey);
        drawRoute();
      });
    return () => controller.abort();
  }, [legKey, leg, targetLon, targetLat, drawRoute]);

  useEffect(() => {
    if (!online) return;
    const timer = window.setInterval(() => {
      const d = drive.current;
      if (autopilotOn.current && d) {
        const total = d.cumulative[d.cumulative.length - 1];
        if (d.elapsed < total) {
          d.elapsed = Math.min(total, d.elapsed + TICK_SECONDS * speed);
          moveTo(positionAt(d, d.elapsed));
        }
      }
      const ws = socket.current;
      if (ws) send(ws);
      if (position.current) savePosition(id, position.current);
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [online, id, speed, socket, send, moveTo]);

  const destinations = ride
    ? [point(lngLat(ride.store), { kind: "loja" }), point(lngLat(ride.customer), { kind: "cliente" })]
    : offer
      ? [point(lngLat(offer.store), { kind: "loja" }), point(lngLat(offer.customer), { kind: "cliente" })]
      : [];
  const destinationsKey = JSON.stringify(destinations.map((f) => f.geometry.coordinates));

  useEffect(() => {
    if (!ready) return;
    map.current?.getSource<GeoJSONSource>("destinos")?.setData(collection(destinations));
  }, [map, ready, destinationsKey]);

  useEffect(() => {
    setActionError(null);
  }, [ride?.id, ride?.status, ride?.ready_at, offer?.id]);

  useEffect(() => {
    if (ride || offer) setNotice(null);
  }, [ride?.id, offer?.id]);

  const run = async (action: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      done?.();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  if (missing || (!courier && loadError)) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-[15px] font-semibold">{missing ? "Entregador não encontrado" : loadError}</p>
          <Link to="/entregador" className="link mt-2 inline-block text-sm">
            Escolher um entregador
          </Link>
        </div>
      </div>
    );
  }

  if (simOwned) {
    return (
      <div className="absolute inset-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-md px-4 pb-10 pt-8 sm:px-6">
          <p className="text-xs text-muted">
            Entregador <span className="mono">#{id}</span>
          </p>
          <h1 className="mt-0.5 text-[17px] font-semibold tracking-tight">{courier.name}</h1>
          <section className="mt-5 border-l-2 border-line pl-3" data-testid="do-simulador">
            <p className="text-sm text-strong">Este entregador é do simulador.</p>
            <p className="mt-1 text-sm text-muted">
              Ele trabalha sozinho. Para pilotar pelo celular, escolha um que esteja offline.
            </p>
          </section>
          <Link to="/entregador" className="link mt-4 inline-block text-sm">
            Escolher outro entregador
          </Link>
        </div>
      </div>
    );
  }

  const chip = courier ? STATUS_CHIPS[courier.status] : null;
  const here = position.current;
  const current = drive.current && drive.current.key === legKey && routeKey === legKey ? drive.current : null;
  const remaining = current ? current.cumulative[current.cumulative.length - 1] - current.elapsed : null;
  const offerLeft = offer ? Math.max(0, Math.ceil((Date.parse(offer.expires_at) - Date.now()) / 1000)) : 0;
  const hurry = offerLeft <= 10;

  return (
    <div className="absolute inset-0 flex justify-center sm:py-5">
      <div className={frame}>
        <header className="flex shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-4">
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold tracking-tight">{courier?.name ?? "Carregando…"}</h1>
            <p
              className={`mt-0.5 text-xs ${online ? (connected ? "text-muted" : "text-warn") : "text-target"}`}
              data-testid="conexao"
              aria-live="polite"
            >
              {online ? (connected ? "GPS ao vivo" : "conectando…") : "sem GPS"}
            </p>
          </div>
          {chip && (
            <p className="flex shrink-0 items-center gap-2 pt-1 text-[13px]" data-testid="situacao">
              <span className="size-2 rounded-[2px]" style={{ background: chip.color }} />
              {chip.label}
            </p>
          )}
        </header>
        {cityError && <p className="px-4 pb-2 text-xs text-target">{cityError}</p>}

        <div className="relative min-h-44 flex-1 border-y border-line">
          <MapSurface container={container} ready={ready} />
          {!ready && !cityError && (
            <p className="absolute inset-0 grid place-items-center text-xs text-faint">Carregando a cidade…</p>
          )}
          <p className="absolute bottom-0 right-0 rounded-tl-md bg-ink/80 px-1.5 py-0.5 text-[10px] leading-snug text-faint">
            <OsmCredit />
          </p>
        </div>

        <div className="max-h-[68%] shrink-0 overflow-y-auto px-4 pb-4 pt-4">
          {/* O aviso visível nasce junto com a seção de espera; região viva precisa existir antes. */}
          <p className="sr-only" aria-live="polite">
            {notice ?? ""}
          </p>
          {offer && (
            <section data-testid="oferta" data-pedido={offer.order_id}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="section-title">
                  Nova oferta <span className="mono ml-1 font-normal text-muted">#{offer.order_id}</span>
                </h2>
                <p
                  className={`num text-[13px] font-medium ${hurry ? "text-target" : "text-strong"}`}
                  data-testid="oferta-contagem"
                >
                  {offerLeft}&nbsp;s
                </p>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <div
                  className={`h-full w-full origin-left rounded-full transition-transform duration-1000 ease-linear motion-reduce:transition-none ${hurry ? "bg-target" : "bg-strong"}`}
                  style={{ transform: `scaleX(${Math.min(1, offerLeft / OFFER_SECONDS)})` }}
                />
              </div>
              <p className="mt-3 text-[15px] font-semibold">{offer.store.name}</p>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                <dt className="text-muted">Até a loja</dt>
                <dd className="num">
                  {here ? formatDistance(metersBetween(here, lngLat(offer.store))) : "—"}
                  <span className="ml-2 text-muted">{formatDuration(offer.eta_seconds)}</span>
                </dd>
                <dt className="text-muted">Loja ao cliente</dt>
                <dd className="num">
                  {formatDistance(metersBetween(lngLat(offer.store), lngLat(offer.customer)))}
                  <span className="ml-2 text-muted">em linha reta</span>
                </dd>
              </dl>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={big}
                  disabled={busy}
                  onClick={() => run(() => declineOffer(offer.id, id))}
                >
                  Recusar
                </button>
                <button
                  type="button"
                  className={bigPrimary}
                  disabled={busy}
                  onClick={() => run(() => acceptOffer(offer.id, id))}
                >
                  Aceitar
                </button>
              </div>
            </section>
          )}

          {ride && (
            <section data-testid="corrida" data-pedido={ride.id}>
              <p className="text-xs text-muted">
                Pedido <span className="mono">#{ride.id}</span>
              </p>
              <p
                className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight"
                data-testid="corrida-status"
                aria-live="polite"
              >
                {RIDE_LABELS[ride.status] ?? ride.status}
              </p>
              <p className="mt-1 text-sm text-muted">{ride.store.name}</p>
              {leg && (
                <p className="mt-2 text-[13px] text-strong" data-testid="chegada">
                  {!autopilot ? (
                    "Parado, piloto desligado"
                  ) : remaining === null ? (
                    <span className="text-muted">Calculando a rota…</span>
                  ) : remaining > 0 ? (
                    <>
                      Chega {leg === "loja" ? "à loja" : "ao cliente"} em{" "}
                      <span className="num">~{formatDuration(remaining / speed)}</span>
                    </>
                  ) : (
                    "Chegando…"
                  )}
                </p>
              )}
              {ride.status === "na_loja" && (
                <>
                  {!ride.ready_at && (
                    <p className="mt-3 border-l-2 border-muted pl-3 text-[13px] text-strong" data-testid="ainda-nao-pronto">
                      A comida ainda não está pronta. Espere a loja marcar pronto.
                    </p>
                  )}
                  <button
                    type="button"
                    className={`${bigPrimary} mt-3`}
                    disabled={busy}
                    onClick={() => run(() => pickupOrder(ride.id, id))}
                  >
                    Confirmar retirada
                  </button>
                </>
              )}
              {ride.status === "no_cliente" && (
                <button
                  type="button"
                  className={`${bigPrimary} mt-3`}
                  disabled={busy}
                  onClick={() => run(() => deliverOrder(ride.id, id), () => setNotice(`Pedido #${ride.id} entregue.`))}
                >
                  Confirmar entrega
                </button>
              )}
            </section>
          )}

          {courier && !offer && !ride && (
            <section data-testid="espera">
              {notice && (
                <p className="mb-3 border-l-2 border-origin pl-3 text-[13px] text-origin" data-testid="aviso-entrega">
                  {notice}
                </p>
              )}
              <p className="text-[15px] font-semibold">{online ? "Esperando um pedido" : "Você está offline"}</p>
              <p className="meta mt-0.5">
                {online
                  ? `As ofertas aparecem aqui. Você tem ${OFFER_SECONDS} s para responder.`
                  : "Fique online para receber ofertas perto de você."}
              </p>
            </section>
          )}

          {actionError && (
            <p className="mt-3 text-sm text-target" data-testid="erro-acao" role="alert">
              {actionError}
            </p>
          )}

          <div className={`mt-4 flex-col gap-3 border-t border-line pt-4 ${courier ? "flex" : "hidden"}`}>
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span className="block text-[13px] font-medium">Piloto automático</span>
                <span className="meta block">
                  {autopilot
                    ? `Segue a rota a ${speed}× a velocidade da via.`
                    : "Desligado, você fica parado. A central avisa em 30 s."}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                name="piloto_automatico"
                checked={autopilot}
                onChange={(e) => setAutopilot(e.target.checked)}
                className={toggle}
              />
            </label>
            {courier?.status === "offline" ? (
              <button
                type="button"
                className={bigPrimary}
                disabled={busy}
                onClick={() => run(() => courierOnline(id, true))}
              >
                Ficar online
              </button>
            ) : courier?.status === "livre" ? (
              <button type="button" className={big} disabled={busy} onClick={() => run(() => courierOffline(id))}>
                Ficar offline
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
