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

export interface Point {
  lat: number;
  lon: number;
}

export interface LiveOrder {
  id: number;
  status: string;
  version: number;
  store?: Point;
  customer?: Point;
  store_name?: string;
  courier_id?: number;
}

export interface Stats {
  orders: Record<string, number>;
  couriers: Record<string, number>;
  delivered: number;
  avg_delivery_seconds: number | null;
}

export interface TimelineEntry {
  type: string;
  status: string;
  actor: string;
  at: string;
}

export interface OrderDetail {
  id: number;
  status: string;
  version: number;
  store: Point & { id: number; name: string };
  customer: Point;
  courier: { id: number; name: string } | null;
  prep_minutes: number | null;
  ready_at: string | null;
  promised_at: string | null;
  created_at: string;
  timeline: TimelineEntry[];
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

export async function fetchStats(): Promise<Stats> {
  return read(await fetch("/api/stats"));
}

export async function fetchOrder(id: number): Promise<OrderDetail | null> {
  const res = await fetch(`/api/orders/${id}`);
  if (res.status === 404) return null;
  return read(res);
}
