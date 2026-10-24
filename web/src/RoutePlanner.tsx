import { useEffect, useRef, useState } from "react";
import { Marker, type GeoJSONSource, type Map as MapLibre, type MapMouseEvent } from "maplibre-gl";
import { fetchRoute, type LngLat, type RouteResult } from "./api";
import { COLORS, EMPTY, ROADS, byZoom, line, pin, point, useCityMap } from "./cityMap";
import { formatDistance, formatDuration, formatInt, formatSpeed } from "./format";
import { MapSurface, OsmCredit } from "./MapParts";

type Points = { origin?: LngLat; target?: LngLat };

function listRoads(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
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

function addRouteLayers(map: MapLibre) {
  map.addSource("rota", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "rota-borda",
    type: "line",
    source: "rota",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.ink, "line-width": byZoom(6, 9, 15) },
  });
  map.addLayer({
    id: "rota",
    type: "line",
    source: "rota",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.route, "line-width": byZoom(3, 5, 9) },
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

export default function RoutePlanner() {
  const { container, map, meta, ready, error: cityError } = useCityMap(addRouteLayers);
  const markers = useRef<{ origin?: Marker; target?: Marker }>({});
  const [points, setPoints] = useState<Points>({});
  const [rain, setRain] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const error = cityError ?? routeError;

  useEffect(() => {
    document.title = "Rota · GDrive";
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.getCanvas().style.cursor = "crosshair";
    const onClick = (e: MapMouseEvent) => {
      const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
      setPoints((p) => (p.origin && !p.target ? { ...p, target: at } : { origin: at }));
    };
    m.on("click", onClick);
    return () => {
      m.off("click", onClick);
    };
  }, [map, ready]);

  useEffect(() => {
    const { origin, target } = points;
    if (!origin || !target) {
      setRoute(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setRouteError(null);
    fetchRoute(origin, target, rain, ctrl.signal)
      .then(setRoute)
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setRoute(null);
        setRouteError(err.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [points, rain]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const place = (key: "origin" | "target", at: LngLat | undefined, label: string, color: string) => {
      let marker = markers.current[key];
      if (!at) {
        marker?.remove();
        markers.current[key] = undefined;
        return;
      }
      if (!marker) {
        marker = new Marker({ element: pin(label, color) });
        markers.current[key] = marker;
      }
      marker.setLngLat(at).addTo(m);
    };
    const path = route?.path.coordinates;
    place("origin", path ? path[0] : points.origin, "A", COLORS.origin);
    place("target", path ? path[path.length - 1] : points.target, "B", COLORS.target);
  }, [map, points, route, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const routeLine = m.getSource<GeoJSONSource>("rota");
    const dot = m.getSource<GeoJSONSource>("entregador");
    if (!route) {
      routeLine?.setData(EMPTY);
      dot?.setData(EMPTY);
      return;
    }
    routeLine?.setData(line(route.path.coordinates));
    const total = route.cumulative_seconds[route.cumulative_seconds.length - 1];
    const duration = Math.min(6000, Math.max(2000, total * 15));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = still ? 1 : Math.min(1, (now - start) / duration);
      dot?.setData(point(positionAt(route, t * total)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [map, route, ready]);

  const rainPercent = meta ? Math.round((meta.rain_factor - 1) * 100) : 40;

  return (
    <div className="absolute inset-0">
      <MapSurface container={container} ready={ready} />
      <aside className="absolute left-4 top-4 max-h-[calc(100%-2rem)] w-[min(22rem,calc(100%-2rem))] overflow-y-auto rounded-xl border border-white/10 bg-panel/95 p-4 shadow-2xl backdrop-blur">
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

        <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-snug text-zinc-500">
          <OsmCredit />
        </p>
      </aside>
    </div>
  );
}
