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

export type AlertKind = "sinal_perdido" | "parado" | "desvio" | "atraso" | "sem_entregador";

export interface LiveOrder {
  id: number;
  status: string;
  version: number;
  store?: Point;
  customer?: Point;
  store_name?: string;
  courier_id?: number;
  alerts?: Partial<Record<AlertKind, number>>;
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
  store: Point & { id: number; name: string; manual: boolean };
  customer: Point;
  courier: { id: number; name: string } | null;
  prep_minutes: number | null;
  ready_at: string | null;
  promised_at: string | null;
  created_at: string;
  timeline: TimelineEntry[];
}

export interface RouteOption {
  seconds: number;
  meters: number;
  roads: { name: string; meters: number }[];
  path: LineString & { coordinates: LngLat[] };
}

export interface RouteAlternatives {
  fastest: RouteOption;
  shortest: RouteOption;
  no_expressway: RouteOption | null;
}

export interface Candidate {
  courier_id: number;
  eta_seconds: number;
  distance_m: number;
}

export interface Offer {
  id: number;
  courier_id: number;
  status: "pendente" | "aceita" | "recusada" | "expirada";
  radius_m: number;
  eta_seconds: number;
  candidates: Candidate[];
  created_at: string;
  expires_at: string;
}

export interface Dispatch {
  order_id: number;
  offers: Offer[];
}

export type Leg = "loja" | "cliente";

export interface LegPlan {
  from: LngLat;
  path: LngLat[];
  seconds: number;
  meters: number;
  at: number;
}

export type TrackPoint = [lon: number, lat: number, at: number];

export interface Journey {
  order_id: number;
  plan: Partial<Record<Leg, LegPlan>>;
  track: Partial<Record<Leg, TrackPoint[]>>;
}

export interface StoreSummary extends Point {
  id: number;
  name: string;
  manual: boolean;
}

export interface StoreInfo extends StoreSummary {
  default_prep_minutes: number;
}

export interface StoreOrder {
  id: number;
  status: string;
  created_at: string;
  updated_at: string;
  prep_minutes: number | null;
  ready_at: string | null;
  promised_at: string | null;
  courier_id: number | null;
  courier_name: string | null;
  customer_lat: number;
  customer_lon: number;
}

export interface CourierOffer {
  id: number;
  order_id: number;
  eta_seconds: number;
  expires_at: string;
  store: Point & { name: string };
  customer: Point;
}

export interface CourierRide {
  id: number;
  status: string;
  ready_at: string | null;
  store: Point & { id: number; name: string };
  customer: Point;
}

export interface CourierView {
  id: number;
  name: string;
  status: "offline" | "livre" | "ocupado";
  human: boolean;
  home: Point;
  offer: CourierOffer | null;
  order: CourierRide | null;
}

export interface CourierSummary extends Point {
  id: number;
  name: string;
  status: "offline" | "livre" | "ocupado";
  human: boolean;
}

export interface HistoryItem {
  id: number;
  store_name: string;
  courier_id: number | null;
  courier_name: string | null;
  created_at: string;
  delivered_at: string | null;
  promised_at: string | null;
  seconds: number | null;
  late: boolean | null;
  meters: number | null;
  alerts: number;
}

export interface HistoryPage {
  total: number;
  items: HistoryItem[];
}

export interface TrackLeg {
  courier_id: number | null;
  meters: number;
  track: TrackPoint[];
  planned: LngLat[] | null;
  planned_seconds: number | null;
  planned_meters: number | null;
}

export interface AlertRecord {
  kind: AlertKind;
  courier_id: number | null;
  detail: Record<string, number>;
  opened_at: string;
  closed_at: string | null;
}

export interface OrderTrack {
  order_id: number;
  status: string;
  store: Point & { id: number; name: string };
  customer: Point;
  courier_id: number | null;
  courier_name: string | null;
  created_at: string;
  promised_at: string | null;
  delivered_at: string | null;
  legs: Partial<Record<Leg, TrackLeg>>;
  timeline: TimelineEntry[];
  alerts: AlertRecord[];
}

export interface SimState {
  rain: boolean;
  rush: number;
}

export type SimAction = "sem_sinal" | "parar" | "desviar";

async function read<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.detail?.[0]?.msg ?? `o servidor respondeu ${res.status}`);
  }
  return body as T;
}

async function send<T>(method: "POST" | "PUT", url: string, body?: unknown): Promise<T> {
  return read(
    await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
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

export async function fetchAlternatives(from: LngLat, to: LngLat, signal: AbortSignal): Promise<RouteAlternatives> {
  const res = await fetch("/route/alternatives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: { lon: from[0], lat: from[1] }, to: { lon: to[0], lat: to[1] }, rain: false }),
    signal,
  });
  return read(res);
}

export async function fetchDispatch(id: number): Promise<Dispatch> {
  return read(await fetch(`/api/orders/${id}/dispatch`));
}

export async function fetchJourney(id: number): Promise<Journey> {
  return read(await fetch(`/journey/${id}`));
}

export async function fetchStores(q: string, limit = 20): Promise<StoreSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q.trim()) params.set("q", q.trim());
  return read(await fetch(`/api/stores?${params}`));
}

export async function fetchStore(id: number): Promise<StoreInfo | null> {
  const res = await fetch(`/api/stores/${id}`);
  if (res.status === 404) return null;
  return read(res);
}

export function setStoreManual(id: number, manual: boolean): Promise<StoreInfo> {
  return send("PUT", `/api/stores/${id}/manual`, { manual });
}

export async function fetchStoreOrders(id: number): Promise<StoreOrder[]> {
  return read(await fetch(`/api/stores/${id}/orders`));
}

export function createTestOrder(storeId: number): Promise<{ id: number; status: string; promised_at: string }> {
  return send("POST", `/api/stores/${storeId}/test-order`);
}

export function storeAccept(storeId: number, orderId: number, prepMinutes: number): Promise<unknown> {
  return send("POST", `/api/stores/${storeId}/orders/${orderId}/accept`, { prep_minutes: prepMinutes });
}

export function storeReject(storeId: number, orderId: number): Promise<unknown> {
  return send("POST", `/api/stores/${storeId}/orders/${orderId}/reject`);
}

export function storeReady(storeId: number, orderId: number): Promise<unknown> {
  return send("POST", `/api/stores/${storeId}/orders/${orderId}/ready`);
}

export async function fetchCouriers(params: {
  status?: string;
  human?: boolean;
  limit?: number;
  offset?: number;
}): Promise<CourierSummary[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return read(await fetch(`/api/couriers?${query}`));
}

export async function fetchCourier(id: number): Promise<CourierView | null> {
  const res = await fetch(`/api/couriers/${id}`);
  if (res.status === 404) return null;
  return read(res);
}

export function courierOnline(id: number, human = true): Promise<unknown> {
  return send("POST", `/api/couriers/${id}/online`, { human });
}

export function courierOffline(id: number): Promise<unknown> {
  return send("POST", `/api/couriers/${id}/offline`);
}

export function acceptOffer(offerId: number, courierId: number): Promise<unknown> {
  return send("POST", `/api/offers/${offerId}/accept`, { courier_id: courierId });
}

export function declineOffer(offerId: number, courierId: number): Promise<unknown> {
  return send("POST", `/api/offers/${offerId}/decline`, { courier_id: courierId });
}

export function pickupOrder(orderId: number, courierId: number): Promise<unknown> {
  return send("POST", `/api/orders/${orderId}/pickup`, { courier_id: courierId });
}

export function deliverOrder(orderId: number, courierId: number): Promise<unknown> {
  return send("POST", `/api/orders/${orderId}/deliver`, { courier_id: courierId });
}

export async function fetchCandidates(orderId: number): Promise<Candidate[]> {
  return read(await fetch(`/api/orders/${orderId}/candidates`));
}

export function assignOrder(orderId: number, courierId: number): Promise<unknown> {
  return send("POST", `/api/orders/${orderId}/assign`, { courier_id: courierId });
}

export function unassignOrder(orderId: number): Promise<{ status: string; courier_id: number }> {
  return send("POST", `/api/orders/${orderId}/unassign`);
}

export async function fetchHistory(limit = 50, offset = 0): Promise<HistoryPage> {
  return read(await fetch(`/api/history?limit=${limit}&offset=${offset}`));
}

export async function fetchTrack(id: number): Promise<OrderTrack | null> {
  const res = await fetch(`/api/orders/${id}/track`);
  if (res.status === 404) return null;
  return read(res);
}

export async function fetchSim(): Promise<SimState> {
  return read(await fetch("/api/sim"));
}

export function updateSim(change: Partial<SimState>): Promise<SimState> {
  return send("PUT", "/api/sim", change);
}

export function simCommand(courierId: number, action: SimAction, seconds = 60): Promise<unknown> {
  return send("POST", `/api/sim/couriers/${courierId}/${action}`, { seconds });
}
