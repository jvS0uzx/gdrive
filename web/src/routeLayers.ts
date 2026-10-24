import type { ExpressionSpecification, Map as MapLibre } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { Journey, Leg, LngLat, RouteAlternatives, TrackPoint } from "./api";
import { COLORS, EMPTY, byZoom, collection, line } from "./cityMap";

export const LEGS: Leg[] = ["loja", "cliente"];

export const LEG_COLORS: Record<Leg, string> = { loja: COLORS.store, cliente: COLORS.customer };

const legColor: ExpressionSpecification = ["match", ["get", "leg"], "cliente", LEG_COLORS.cliente, LEG_COLORS.loja];
const round = { "line-cap": "round", "line-join": "round" } as const;

export function addPlannedLayer(map: MapLibre) {
  map.addSource("jornada", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "jornada-prevista",
    type: "line",
    source: "jornada",
    filter: ["==", ["get", "kind"], "plan"],
    layout: { "line-join": "round" },
    paint: { "line-color": legColor, "line-width": byZoom(1.5, 2.5, 4), "line-dasharray": [2, 1.5] },
  });
}

export function addWalkedLayers(map: MapLibre) {
  map.addLayer({
    id: "jornada-andada-borda",
    type: "line",
    source: "jornada",
    filter: ["==", ["get", "kind"], "track"],
    layout: round,
    paint: { "line-color": COLORS.ink, "line-width": byZoom(4.5, 6.5, 10) },
  });
  map.addLayer({
    id: "jornada-andada",
    type: "line",
    source: "jornada",
    filter: ["==", ["get", "kind"], "track"],
    layout: round,
    paint: { "line-color": legColor, "line-width": byZoom(2.5, 3.5, 6) },
  });
}

export function addAlternativeLayers(map: MapLibre) {
  map.addSource("alternativas", { type: "geojson", data: EMPTY });
  for (const [kind, color] of [
    ["no_expressway", COLORS.noExpressway],
    ["shortest", COLORS.shortest],
  ] as const) {
    map.addLayer({
      id: `alternativa-${kind}`,
      type: "line",
      source: "alternativas",
      filter: ["==", ["get", "kind"], kind],
      layout: { "line-join": "round" },
      paint: { "line-color": color, "line-width": byZoom(1.5, 2.5, 4), "line-dasharray": [1.5, 1.5] },
    });
  }
  map.addLayer({
    id: "alternativa-fastest-borda",
    type: "line",
    source: "alternativas",
    filter: ["==", ["get", "kind"], "fastest"],
    layout: round,
    paint: { "line-color": COLORS.ink, "line-width": byZoom(5, 7.5, 12) },
  });
  map.addLayer({
    id: "alternativa-fastest",
    type: "line",
    source: "alternativas",
    filter: ["==", ["get", "kind"], "fastest"],
    layout: round,
    paint: { "line-color": COLORS.route, "line-width": byZoom(2.5, 4, 7) },
  });
}

export function alternativeFeatures(alternatives: RouteAlternatives | null): FeatureCollection {
  if (!alternatives) return EMPTY;
  const features: Feature[] = [];
  for (const kind of ["no_expressway", "shortest", "fastest"] as const) {
    const option = alternatives[kind];
    if (option) features.push(line(option.path.coordinates, { kind }));
  }
  return collection(features);
}

const coordinates = (track: TrackPoint[]): LngLat[] => track.map(([lon, lat]) => [lon, lat]);

export function journeyFeatures(journey: Journey | null): FeatureCollection {
  if (!journey) return EMPTY;
  const features: Feature[] = [];
  for (const leg of LEGS) {
    const plan = journey.plan[leg];
    const track = journey.track[leg];
    if (plan && plan.path.length > 1) features.push(line(plan.path, { kind: "plan", leg }));
    if (track && track.length > 1) features.push(line(coordinates(track), { kind: "track", leg }));
  }
  return collection(features);
}

export const OFF_ROUTE_METERS = 50;

function metersToSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_574;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function deviation(
  track: TrackPoint[] | undefined,
  path: LngLat[] | undefined,
): { max: number; inside: number; total: number } {
  if (!track || track.length === 0 || !path || path.length < 2) return { max: 0, inside: 0, total: 0 };
  let max = 0;
  let inside = 0;
  for (const [lon, lat] of track) {
    let nearest = Infinity;
    for (let i = 1; i < path.length; i++) nearest = Math.min(nearest, metersToSegment([lon, lat], path[i - 1], path[i]));
    max = Math.max(max, nearest);
    if (nearest <= OFF_ROUTE_METERS) inside += 1;
  }
  return { max, inside, total: track.length };
}

export function lastPosition(journey: Journey | null): LngLat | null {
  for (const leg of [...LEGS].reverse()) {
    const track = journey?.track[leg];
    if (track && track.length > 0) {
      const [lon, lat] = track[track.length - 1];
      return [lon, lat];
    }
  }
  return null;
}
