import { useEffect, useMemo, useRef, useState } from "react";
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MapLibre } from "maplibre-gl";
import type { Feature } from "geojson";
import { fetchTrack, type Leg, type LngLat, type OrderTrack, type TrackLeg, type TrackPoint } from "./api";
import { COLORS, EMPTY, collection, line, panelPadding, pin, point, useCityMap } from "./cityMap";
import { formatClock, formatDistance, formatDuration } from "./format";
import { actorLabel, alertHint, alertLabel, eventLabel } from "./labels";
import { FloatingCredit, LineSample, MapSurface } from "./MapParts";
import { LEGS, LEG_COLORS, addPlannedLayer, addWalkedLayers, deviation } from "./routeLayers";
import { Link } from "./router";

const SPEEDS = [1, 4, 16, 64];
const DEFAULT_SPEED = 4;
const SLIDER_STEP_MS = 100;
const LEG_LABELS: Record<Leg, string> = { loja: "Até a loja", cliente: "Até o cliente" };

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const STORE_ICON = icon('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>');
const HOME_ICON = icon('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>');

interface LegReplay {
  leg: Leg;
  data: TrackLeg;
  start: number;
  end: number;
  deviation: { max: number; inside: number; total: number };
}

function indexAt(track: TrackPoint[], clock: number): number {
  if (track.length === 0 || clock < track[0][2]) return -1;
  let lo = 0;
  let hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid][2] <= clock) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function interpolate(track: TrackPoint[], i: number, clock: number): LngLat {
  if (i < 0) return [track[0][0], track[0][1]];
  if (i >= track.length - 1) return [track[track.length - 1][0], track[track.length - 1][1]];
  const [aLon, aLat, aAt] = track[i];
  const [bLon, bLat, bAt] = track[i + 1];
  const f = bAt > aAt ? (clock - aAt) / (bAt - aAt) : 0;
  return [aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f];
}

function walkedFeatures(legs: LegReplay[], clock: number): Feature[] {
  const features: Feature[] = [];
  for (const l of legs) {
    if (clock < l.start) continue;
    const track = l.data.track;
    const i = indexAt(track, clock);
    const coords: LngLat[] = track.slice(0, i + 1).map(([lon, lat]) => [lon, lat]);
    if (i < track.length - 1) coords.push(interpolate(track, i, clock));
    if (coords.length > 1) features.push(line(coords, { kind: "track", leg: l.leg }));
  }
  return features;
}

function courierAt(legs: LegReplay[], clock: number): LngLat | null {
  if (legs.length === 0) return null;
  let at = interpolate(legs[0].data.track, -1, clock);
  for (const l of legs) {
    if (clock < l.start) break;
    at = interpolate(l.data.track, indexAt(l.data.track, clock), clock);
  }
  return at;
}

function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function alertDetail(detail: Record<string, number>): string {
  if (detail.meters !== undefined) return `a ${Math.round(detail.meters)} m da rota`;
  if (detail.seconds !== undefined) return `${Math.round(detail.seconds)} s sem sair do lugar`;
  return "";
}

function addReplayLayers(map: MapLibre) {
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

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      {playing ? (
        <>
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </>
      ) : (
        <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />
      )}
    </svg>
  );
}

export default function Replay({ id }: { id: number }) {
  const { container, map, ready, error: cityError } = useCityMap(addReplayLayers);
  const [track, setTrack] = useState<OrderTrack | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const markers = useRef<Marker[]>([]);
  const fitted = useRef(false);
  const aside = useRef<HTMLElement>(null);

  useEffect(() => {
    document.title = `Replay #${id} · GDrive`;
    let alive = true;
    fetchTrack(id)
      .then((t) => {
        if (!alive) return;
        if (!t) setMissing(true);
        else setTrack(t);
      })
      .catch((err: Error) => alive && setLoadError(`O trajeto não carregou: ${err.message}`));
    return () => {
      alive = false;
    };
  }, [id]);

  const legs = useMemo<LegReplay[]>(() => {
    if (!track) return [];
    return LEGS.flatMap((leg) => {
      const data = track.legs[leg];
      if (!data || data.track.length === 0) return [];
      return [
        {
          leg,
          data,
          start: data.track[0][2],
          end: data.track[data.track.length - 1][2],
          deviation: deviation(data.track, data.planned ?? undefined),
        },
      ];
    }).sort((a, b) => a.start - b.start);
  }, [track]);

  const range = useMemo(() => {
    if (legs.length === 0) return null;
    const delivered = track?.delivered_at ? Date.parse(track.delivered_at) : 0;
    return { start: legs[0].start, end: Math.max(delivered, ...legs.map((l) => l.end)) };
  }, [legs, track]);

  const planned = useMemo<Feature[]>(
    () =>
      legs.flatMap((l) =>
        l.data.planned && l.data.planned.length > 1 ? [line(l.data.planned, { kind: "plan", leg: l.leg })] : [],
      ),
    [legs],
  );

  const events = useMemo(() => (track?.timeline ?? []).map((e) => ({ ...e, ms: Date.parse(e.at) })), [track]);
  const alerts = useMemo(
    () =>
      (track?.alerts ?? []).map((a) => ({
        ...a,
        opened: Date.parse(a.opened_at),
        closed: a.closed_at ? Date.parse(a.closed_at) : null,
      })),
    [track],
  );

  useEffect(() => {
    if (range) setClock(range.start);
  }, [range]);

  useEffect(() => {
    if (!playing || !range) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setClock((c) => Math.min(range.end, c + dt * speed));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, range]);

  useEffect(() => {
    if (playing && range && clock >= range.end) setPlaying(false);
  }, [playing, clock, range]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !range) return;
    m.getSource<GeoJSONSource>("jornada")?.setData(collection([...planned, ...walkedFeatures(legs, clock)]));
    const at = courierAt(legs, clock);
    m.getSource<GeoJSONSource>("entregador")?.setData(at ? point(at) : EMPTY);
  }, [map, ready, range, legs, planned, clock]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !track) return;
    const store: LngLat = [track.store.lon, track.store.lat];
    const home: LngLat = [track.customer.lon, track.customer.lat];
    if (markers.current.length === 0) {
      markers.current = [
        new Marker({ element: pin(STORE_ICON, COLORS.store) }).setLngLat(store).addTo(m),
        new Marker({ element: pin(HOME_ICON, COLORS.customer) }).setLngLat(home).addTo(m),
      ];
    }
    if (fitted.current) return;
    fitted.current = true;
    const bounds = new LngLatBounds(store, store).extend(home);
    for (const l of legs) {
      for (const [lon, lat] of l.data.track) bounds.extend([lon, lat]);
      for (const p of l.data.planned ?? []) bounds.extend(p);
    }
    const below = (aside.current?.offsetHeight ?? 0) + 40;
    const padding = window.innerWidth > 900 ? panelPadding(72) : { top: below, bottom: 64, left: 32, right: 32 };
    m.fitBounds(bounds, { padding, maxZoom: 16, duration: 0 });
  }, [map, ready, track, legs]);

  useEffect(() => {
    const placed = markers;
    return () => {
      for (const marker of placed.current) marker.remove();
      placed.current = [];
    };
  }, []);

  const togglePlay = () => {
    if (!range) return;
    if (!playing && clock >= range.end) setClock(range.start);
    setPlaying((p) => !p);
  };

  const seek = (ms: number) => {
    if (range) setClock(Math.min(range.end, Math.max(range.start, ms)));
  };

  const sliderMax = range ? Math.ceil((range.end - range.start) / SLIDER_STEP_MS) * SLIDER_STEP_MS : 0;
  const lastEvent = events.reduce((found, e, i) => (e.ms <= clock ? i : found), -1);
  const late = track?.delivered_at && track.promised_at ? Date.parse(track.delivered_at) > Date.parse(track.promised_at) : null;

  return (
    <div className="absolute inset-0">
      <MapSurface container={container} ready={ready} />
      <aside
        ref={aside}
        className="absolute left-4 top-4 flex max-h-[55%] w-[min(22rem,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl border border-white/10 bg-panel/95 shadow-2xl backdrop-blur md:max-h-[calc(100%-2rem)]">
        <header className="px-4 pb-1 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · replay #{id}</p>
            <Link to="/historico" className="text-[11px] text-zinc-400 hover:text-zinc-200">
              Histórico
            </Link>
          </div>
          {cityError && <p className="mt-1 text-xs text-target">{cityError}</p>}
          {missing ? (
            <>
              <h1 className="mt-1 text-base font-semibold text-zinc-100" data-testid="sem-trajeto">
                Trajeto ainda não gravado
              </h1>
              <p className="mt-1 pb-3 text-sm text-zinc-400">
                O trajeto é salvo quando a entrega termina. Pedido cancelado ou em andamento não tem replay.
              </p>
              <Link to={`/pedido/${id}`} className="inline-block pb-3 text-sm text-route hover:underline">
                Ver o pedido #{id}
              </Link>
            </>
          ) : !track ? (
            <p className={`mt-2 pb-3 text-sm ${loadError ? "text-target" : "text-zinc-400"}`}>
              {loadError ?? "Carregando o trajeto…"}
            </p>
          ) : (
            <>
              <h1 className="mt-1 text-base font-semibold text-zinc-100" data-testid="loja">
                {track.store.name}
              </h1>
              <p className="mt-0.5 text-xs text-zinc-400">
                {track.courier_id !== null ? `Entregador #${track.courier_id}` : "Sem entregador"}
                {track.delivered_at && ` · entregue às ${formatClock(track.delivered_at)}`}
                {late !== null && (
                  <span className={late ? "text-target" : "text-origin"}>{late ? " · atrasado" : " · no prazo"}</span>
                )}
              </p>
            </>
          )}
        </header>

        {track && range && (
          <>
            <section className="mx-4 mt-3 rounded-lg border border-white/10 px-3 py-3" aria-label="Controles do replay">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={togglePlay}
                  data-testid="replay-play"
                  aria-label={playing ? "Pausar" : "Reproduzir"}
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-route text-ink hover:bg-route/90"
                >
                  <PlayIcon playing={playing} />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-semibold leading-tight tabular-nums text-zinc-100" data-testid="replay-relogio">
                    {formatClock(new Date(clock).toISOString(), true)}
                  </p>
                  <p className="text-[11px] tabular-nums text-zinc-500">
                    {elapsedLabel(clock - range.start)} de {elapsedLabel(range.end - range.start)} gravados
                  </p>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={sliderMax}
                step={SLIDER_STEP_MS}
                value={clock >= range.end ? sliderMax : Math.round((clock - range.start) / SLIDER_STEP_MS) * SLIDER_STEP_MS}
                onChange={(e) => seek(range.start + Number(e.target.value))}
                aria-label="Posição do replay"
                data-testid="replay-slider"
                className="mt-3 w-full accent-route"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-500">Velocidade</span>
                <div className="flex overflow-hidden rounded-md border border-white/10" role="group" aria-label="Velocidade do replay">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={speed === s}
                      onClick={() => setSpeed(s)}
                      className={`px-2.5 py-1 text-xs tabular-nums ${
                        speed === s ? "bg-white/15 text-zinc-100" : "text-zinc-400 hover:bg-white/5"
                      }`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="px-4 pt-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Trechos</h2>
              <ul className="mt-2 flex flex-col gap-2">
                {legs.map((l) => {
                  const active = clock >= l.start && clock <= l.end;
                  const share = l.deviation.total > 0 ? Math.round((l.deviation.inside / l.deviation.total) * 100) : null;
                  return (
                    <li
                      key={l.leg}
                      data-testid={`trecho-${l.leg}`}
                      className={`rounded-lg border px-3 py-2 text-xs ${active ? "border-white/25 bg-white/5" : "border-white/10"}`}
                    >
                      <p className="flex items-center gap-1.5 text-zinc-200">
                        <LineSample color={LEG_COLORS[l.leg]} dashed />
                        <LineSample color={LEG_COLORS[l.leg]} />
                        {LEG_LABELS[l.leg]}
                      </p>
                      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                        <dt className="text-zinc-500">Andou</dt>
                        <dd className="tabular-nums text-zinc-200">
                          {formatDistance(l.data.meters)}
                          {l.data.planned_meters !== null && (
                            <span className="text-zinc-500"> de {formatDistance(l.data.planned_meters)} previstos</span>
                          )}
                        </dd>
                        <dt className="text-zinc-500">Duração</dt>
                        <dd className="tabular-nums text-zinc-200">{formatDuration((l.end - l.start) / 1000)}</dd>
                        <dt className="text-zinc-500">Desvio máximo</dt>
                        <dd className="tabular-nums text-zinc-200">
                          {l.data.planned ? (
                            <>
                              {Math.round(l.deviation.max)} m
                              {share !== null && <span className="text-zinc-500"> · {share}% dos pontos na rota</span>}
                            </>
                          ) : (
                            <span className="text-zinc-500">sem rota prevista</span>
                          )}
                        </dd>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            </section>

            {alerts.length > 0 && (
              <section className="px-4 pt-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Alertas</h2>
                <ul className="mt-2 flex flex-col gap-1.5" data-testid="replay-alertas">
                  {alerts.map((a, i) => {
                    const open = clock >= a.opened && (a.closed === null || clock < a.closed);
                    const passed = clock >= a.opened;
                    return (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => seek(a.opened)}
                          data-passou={passed ? "true" : "false"}
                          className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                            open
                              ? "border-target/50 bg-target/10 text-zinc-100"
                              : passed
                                ? "border-white/10 text-zinc-300"
                                : "border-white/5 text-zinc-600"
                          }`}
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <span className={open ? "font-semibold text-target" : undefined}>{alertLabel(a.kind)}</span>
                            <span className="tabular-nums text-[11px]">
                              {formatClock(a.opened_at, true)}
                              {a.closed_at && ` → ${formatClock(a.closed_at, true)}`}
                            </span>
                          </span>
                          <span className="block text-[11px] opacity-80">
                            {[alertHint(a.kind), alertDetail(a.detail)].filter(Boolean).join(" ")}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="flex flex-col px-4 pb-3 pt-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Linha do tempo</h2>
              <ol className="mt-1" data-testid="replay-linha-do-tempo">
                {events.map((e, i) => {
                  const passed = e.ms <= clock;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => seek(e.ms)}
                        data-passou={passed ? "true" : "false"}
                        className={`flex w-full gap-3 rounded px-1 py-1 text-left text-xs transition-colors hover:bg-white/5 ${
                          i === lastEvent ? "bg-white/5" : ""
                        }`}
                      >
                        <time dateTime={e.at} className={`shrink-0 tabular-nums ${passed ? "text-zinc-400" : "text-zinc-600"}`}>
                          {formatClock(e.at, true)}
                        </time>
                        <span className={passed ? (i === lastEvent ? "text-zinc-100" : "text-zinc-300") : "text-zinc-600"}>
                          {eventLabel(e.type)}
                          <span className="text-zinc-600"> · {actorLabel(e.actor)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>

            <footer className="flex flex-wrap gap-x-3 gap-y-1 border-t border-white/10 px-4 py-2.5 text-[11px] text-zinc-400">
              {[
                ["Loja", COLORS.store],
                ["Cliente", COLORS.customer],
              ].map(([label, color]) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  {label}
                </span>
              ))}
              <span className="w-full text-zinc-500">Tracejado é a rota prevista; sólido, o que o entregador andou até o relógio.</span>
            </footer>
          </>
        )}

        {track && !range && (
          <p className="px-4 pb-4 pt-2 text-sm text-zinc-400">Esta entrega não tem pontos de GPS gravados.</p>
        )}
      </aside>
      <FloatingCredit />
    </div>
  );
}
