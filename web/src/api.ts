import type { FeatureCollection, LineString } from "geojson";

export type LngLat = [number, number];

export interface CityMeta {
  name: string;
  source: string;
  nodes: number;
  junctions: number;
  km: number;
  streets: number;
  bbox: [number, number, number, number];
  speeds_kmh: Record<string, number>;
  rain_factor: number;
}

export interface RouteResult {
  from_node: number;
  to_node: number;
  seconds: number;
  meters: number;
  rain: boolean;
  roads: { name: string; meters: number }[];
  path: LineString & { coordinates: LngLat[] };
  cumulative_seconds: number[];
}

async function read<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `o servidor respondeu ${res.status}`);
  }
  return body as T;
}

export async function fetchMeta(): Promise<CityMeta> {
  return read(await fetch("/city"));
}

export async function fetchStreets(): Promise<FeatureCollection<LineString>> {
  return read(await fetch("/city.geojson"));
}

export async function fetchRoute(from: LngLat, to: LngLat, rain: boolean, signal: AbortSignal): Promise<RouteResult> {
  const res = await fetch("/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { lon: from[0], lat: from[1] },
      to: { lon: to[0], lat: to[1] },
      rain,
    }),
    signal,
  });
  return read(res);
}
