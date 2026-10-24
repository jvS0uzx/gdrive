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
    <div className="absolute inset-0 flex flex-col md:flex-row">
      <section className="relative h-[50dvh] shrink-0 md:order-2 md:h-auto md:min-w-0 md:flex-1" aria-label="Mapa">
        <MapSurface container={container} ready={ready} />
      </section>
      <aside className="dock min-h-0 flex-1 overflow-y-auto border-t md:order-1 md:w-[22rem] md:flex-none md:border-r md:border-t-0">
        <header className="px-5 pt-5">
          <h1 className="text-[17px] font-semibold tracking-tight">Rota mais rápida</h1>
          {meta && (
            <p className="meta mt-1">
              {meta.name}: <span className="num">{formatInt(meta.junctions)}</span> cruzamentos e{" "}
              <span className="num">{formatInt(meta.km)}</span> km de vias do mapa real
            </p>
          )}
        </header>

        <section aria-live="polite" className="min-h-28 px-5 pb-5 pt-5">
          {error ? (
            <p className="text-sm text-target">{error}</p>
          ) : !ready ? (
            <p className="text-sm text-muted">Carregando a cidade…</p>
          ) : !points.origin ? (
            <p className="text-sm">Clique no mapa para marcar a origem.</p>
          ) : !points.target ? (
            <p className="text-sm">Agora clique no destino.</p>
          ) : loading && !route ? (
            <p className="text-sm text-muted">Calculando a rota…</p>
          ) : route ? (
            <div>
              <div className="flex items-baseline gap-3">
                <span data-testid="tempo" className="num text-[32px] font-semibold leading-none tracking-tight text-route">
                  {formatDuration(route.seconds)}
                </span>
                <span data-testid="distancia" className="num text-sm text-muted">
                  {formatDistance(route.meters)}
                </span>
              </div>
              <p className="meta mt-2">
                média de <span className="num">{formatSpeed(route.meters, route.seconds)}</span>
                {route.rain ? ", com chuva" : ""}
              </p>
              {route.roads.length > 0 && (
                <p data-testid="vias" className="mt-3 text-[13px] leading-relaxed text-strong">
                  Por {listRoads(route.roads.map((r) => r.name))}
                </p>
              )}
              <p className="mt-3 text-xs text-faint">Outro clique no mapa começa uma rota nova.</p>
            </div>
          ) : null}
        </section>

        <label className="flex cursor-pointer items-center justify-between gap-3 border-y border-line px-5 py-3 transition-colors hover:bg-raised">
          <span>
            <span className="block text-sm font-medium">Chuva</span>
            <span className="meta block">todo trecho fica {rainPercent}% mais lento</span>
          </span>
          <input
            type="checkbox"
            checked={rain}
            onChange={(e) => setRain(e.target.checked)}
            className="size-4 accent-route"
            data-testid="chuva"
          />
        </label>

        <section className="px-5 py-5">
          <h2 className="section-title">Velocidade por tipo de via</h2>
          <p className="mt-0.5 text-xs text-faint">quando o mapa não informa a da própria via</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-[13px]">
            {[...ROADS].reverse().map((road) => (
              <div key={road.id} className="contents">
                <span className="w-6 rounded-full" style={{ background: road.color, height: Math.max(1.5, road.width[1]) }} />
                <dt className="text-muted">{road.label}</dt>
                <dd className="num">{meta?.speeds_kmh[road.id] ?? "—"} km/h</dd>
              </div>
            ))}
            <span className="w-6 text-center font-bold leading-none" style={{ color: COLORS.arrow }}>
              ›
            </span>
            <dt className="col-span-2 text-muted">Mão única, aparece de perto</dt>
          </dl>
        </section>

        <p className="border-t border-line px-5 py-3 text-[11px] leading-snug text-faint">
          <OsmCredit />
        </p>
      </aside>
    </div>
  );
}
