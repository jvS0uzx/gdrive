import { useEffect, useRef, useState } from "react";
import { Map as MapLibre, Marker, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { FeatureCollection } from "geojson";
import { fetchMeta, fetchRoute, fetchStreets, type CityMeta, type LngLat, type RouteResult } from "./api";
import { formatDistance, formatDuration, formatInt, formatSpeed } from "./format";

setWorkerUrl(workerUrl);

const COLORS = {
  ink: "#0d1016",
  arrow: "#9aa4b2",
  route: "#ffb020",
  origin: "#3ddc84",
  target: "#ff5d5d",
};

const ROADS = [
  { id: "travessa", label: "Travessa", color: "#2a313b", width: [0.3, 0.9, 3] },
  { id: "rua", label: "Rua", color: "#3a424f", width: [0.4, 1.2, 4] },
  { id: "coletora", label: "Coletora", color: "#555f6e", width: [0.7, 1.8, 5.5] },
  { id: "avenida", label: "Avenida", color: "#7d8798", width: [1.1, 2.6, 8] },
  { id: "expressa", label: "Via expressa", color: "#a89870", width: [1.6, 3.4, 10] },
] as const;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

type Points = { origin?: LngLat; target?: LngLat };

function arrowImage(): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = COLORS.arrow;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(11, 8);
  ctx.lineTo(21, 16);
  ctx.lineTo(11, 24);
  ctx.stroke();
  return ctx.getImageData(0, 0, 32, 32);
}

function listRoads(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

function pin(label: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "grid size-7 place-items-center rounded-full text-xs font-bold text-ink shadow-lg ring-2 ring-ink";
  el.style.background = color;
  el.textContent = label;
  return el;
}

function positionAt(route: RouteResult, elapsed: number): LngLat {
  const times = route.cumulative_seconds;
  const coords = route.path.coordinates;
  if (elapsed >= times[times.length - 1]) return coords[coords.length - 1];
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= elapsed) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const f = span > 0 ? (elapsed - times[lo]) / span : 1;
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * f, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * f];
}

function addLayers(map: MapLibre, streets: FeatureCollection) {
  const width = (z11: number, z14: number, z17: number) =>
    ["interpolate", ["linear"], ["zoom"], 11, z11, 14, z14, 17, z17] as unknown as number;
  map.addSource("ruas", { type: "geojson", data: streets });
  for (const road of ROADS) {
    map.addLayer({
      id: road.id,
      type: "line",
      source: "ruas",
      filter: ["==", ["get", "class"], road.id],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": road.color, "line-width": width(road.width[0], road.width[1], road.width[2]) },
    });
  }
  map.addImage("mao-unica", arrowImage(), { pixelRatio: 2 });
  map.addLayer({
    id: "mao-unica",
    type: "symbol",
    source: "ruas",
    minzoom: 15.2,
    filter: ["==", ["get", "oneway"], true],
    layout: {
      "symbol-placement": "line-center",
      "icon-image": "mao-unica",
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-size": 0.85,
    },
  });
  map.addSource("rota", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "rota-borda",
    type: "line",
    source: "rota",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.ink, "line-width": width(6, 9, 15) },
  });
  map.addLayer({
    id: "rota",
    type: "line",
    source: "rota",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.route, "line-width": width(3, 5, 9) },
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

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const markers = useRef<{ origin?: Marker; target?: Marker }>({});
  const [meta, setMeta] = useState<CityMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [points, setPoints] = useState<Points>({});
  const [rain, setRain] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: MapLibre | undefined;
    Promise.all([fetchMeta(), fetchStreets()])
      .then(([m, streets]) => {
        if (cancelled || !container.current) return;
        setMeta(m);
        map = new MapLibre({
          container: container.current,
          style: {
            version: 8,
            sources: {},
            layers: [{ id: "fundo", type: "background", paint: { "background-color": COLORS.ink } }],
          },
          bounds: m.bbox,
          fitBoundsOptions: {
            padding: window.innerWidth > 900 ? { top: 32, bottom: 32, right: 32, left: 400 } : 32,
          },
          attributionControl: false,
          dragRotate: false,
          maxZoom: 18,
        });
        mapRef.current = map;
        map.getCanvas().style.cursor = "crosshair";
        map.on("load", () => addLayers(map!, streets));
        map.on("sourcedata", (e) => {
          if (e.sourceId === "ruas" && e.isSourceLoaded) setReady(true);
        });
        map.on("click", (e) => {
          const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
          setPoints((p) => (p.origin && !p.target ? { ...p, target: at } : { origin: at }));
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`A cidade não carregou: ${err.message}`);
      });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const { origin, target } = points;
    if (!origin || !target) {
      setRoute(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchRoute(origin, target, rain, ctrl.signal)
      .then(setRoute)
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setRoute(null);
        setError(err.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [points, rain]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const place = (key: "origin" | "target", at: LngLat | undefined, label: string, color: string) => {
      let m = markers.current[key];
      if (!at) {
        m?.remove();
        markers.current[key] = undefined;
        return;
      }
      if (!m) {
        m = new Marker({ element: pin(label, color) });
        markers.current[key] = m;
      }
      m.setLngLat(at).addTo(map);
    };
    const path = route?.path.coordinates;
    place("origin", path ? path[0] : points.origin, "A", COLORS.origin);
    place("target", path ? path[path.length - 1] : points.target, "B", COLORS.target);
  }, [points, route, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const line = map.getSource<GeoJSONSource>("rota");
    const dot = map.getSource<GeoJSONSource>("entregador");
    if (!route) {
      line?.setData(EMPTY);
      dot?.setData(EMPTY);
      return;
    }
    line?.setData({ type: "Feature", geometry: route.path, properties: {} });
    const total = route.cumulative_seconds[route.cumulative_seconds.length - 1];
    const duration = Math.min(6000, Math.max(2000, total * 15));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = still ? 1 : Math.min(1, (now - start) / duration);
      dot?.setData({ type: "Feature", geometry: { type: "Point", coordinates: positionAt(route, t * total) }, properties: {} });
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [route, ready]);

  const rainPercent = meta ? Math.round((meta.rain_factor - 1) * 100) : 40;

  return (
    <div className="relative h-full w-full font-sans text-zinc-200">
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" data-testid="mapa" />
      </div>
      <aside className="absolute left-4 top-4 w-[min(22rem,calc(100%-2rem))] rounded-xl border border-white/10 bg-panel/95 p-4 shadow-2xl backdrop-blur">
        <header>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · fase 0</p>
          <h1 className="mt-1 text-base font-semibold text-zinc-100">
            Rota mais rápida em {meta?.name ?? "…"}
          </h1>
          {meta && (
            <p className="mt-1 text-xs text-zinc-400">
              {formatInt(meta.junctions)} cruzamentos · {formatInt(meta.km)} km de vias · mapa real
            </p>
          )}
        </header>

        <section aria-live="polite" className="mt-4 min-h-16">
          {error ? (
            <p className="text-sm text-target">{error}</p>
          ) : !ready ? (
            <p className="text-sm text-zinc-400">Carregando a cidade…</p>
          ) : !points.origin ? (
            <p className="text-sm">Clique no mapa para marcar a origem.</p>
          ) : !points.target ? (
            <p className="text-sm">Agora clique no destino.</p>
          ) : loading && !route ? (
            <p className="text-sm text-zinc-400">Calculando a rota…</p>
          ) : route ? (
            <div>
              <div className="flex items-baseline gap-3">
                <span data-testid="tempo" className="text-3xl font-semibold tabular-nums text-route">
                  {formatDuration(route.seconds)}
                </span>
                <span data-testid="distancia" className="text-sm tabular-nums text-zinc-300">
                  {formatDistance(route.meters)}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-400">
                média {formatSpeed(route.meters, route.seconds)}
                {route.rain ? " · com chuva" : ""}
              </p>
              {route.roads.length > 0 && (
                <p data-testid="vias" className="mt-2 text-xs leading-relaxed text-zinc-300">
                  Por {listRoads(route.roads.map((r) => r.name))}
                </p>
              )}
              <p className="mt-2 text-xs text-zinc-500">Clique de novo no mapa para começar outra rota.</p>
            </div>
          ) : null}
        </section>

        <label className="mt-4 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
          <span>
            <span className="block text-sm">Chuva</span>
            <span className="block text-xs text-zinc-400">vias {rainPercent}% mais lentas, mesma rota</span>
          </span>
          <input
            type="checkbox"
            checked={rain}
            onChange={(e) => setRain(e.target.checked)}
            className="size-4 accent-route"
            data-testid="chuva"
          />
        </label>

        <p className="mt-4 text-[11px] text-zinc-500">Velocidade usada quando o mapa não informa a da via</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400">
          {[...ROADS].reverse().map((road) => (
            <div key={road.id} className="contents">
              <span className="w-6 rounded-full" style={{ background: road.color, height: Math.max(1, road.width[1]) }} />
              <dt>{road.label}</dt>
              <dd className="tabular-nums">{meta?.speeds_kmh[road.id] ?? "—"} km/h</dd>
            </div>
          ))}
          <span className="w-6 text-center font-bold leading-none" style={{ color: COLORS.arrow }}>
            ›
          </span>
          <dt className="col-span-2">Mão única, aparece ao aproximar</dt>
        </dl>

        {meta && (
          <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-snug text-zinc-500">
            Mapa:{" "}
            <a
              className="underline decoration-zinc-600 underline-offset-2 hover:text-zinc-300"
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              © colaboradores do OpenStreetMap
            </a>
            , licença ODbL.
          </p>
        )}
      </aside>
    </div>
  );
}
