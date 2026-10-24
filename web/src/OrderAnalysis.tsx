import { useEffect, useRef, useState, type RefObject } from "react";
import { LngLatBounds, type GeoJSONSource, type Map as MapLibre } from "maplibre-gl";
import {
  fetchAlternatives,
  fetchDispatch,
  fetchJourney,
  fetchOrder,
  type Dispatch,
  type Journey,
  type Leg,
  type LiveOrder,
  type LngLat,
  type Offer,
  type OrderDetail,
  type Point,
  type RouteAlternatives,
  type RouteOption,
} from "./api";
import { COLORS, EMPTY } from "./cityMap";
import { formatClock, formatDistance, formatDuration, formatMeters } from "./format";
import { statusFill, statusLabel, statusTone } from "./labels";
import { LineSample } from "./MapParts";
import { LEGS, LEG_COLORS, OFF_ROUTE_METERS, alternativeFeatures, deviation, journeyFeatures } from "./routeLayers";
import { Link } from "./router";

type Stage = "loja" | "cliente" | "fixo";

const JOURNEY_EVERY_MS = 5000;
const SHOWN_CANDIDATES = 6;

const STAGE_TITLES: Record<Stage, string> = {
  loja: "entregador → loja",
  cliente: "entregador → cliente",
  fixo: "loja → cliente",
};

const OUTCOMES: Record<Offer["status"], string> = {
  pendente: "ainda não respondeu",
  aceita: "aceitou",
  recusada: "recusou",
  expirada: "deixou vencer",
};

const LEG_TITLES: Record<Leg, string> = { loja: "Até a loja", cliente: "Até o cliente" };

const LEG_DONE: Record<Leg, string[]> = {
  loja: ["na_loja", "em_rota", "no_cliente", "entregue"],
  cliente: ["no_cliente", "entregue"],
};

const ALTERNATIVES = [
  { key: "fastest", label: "Escolhida (mais rápida)", color: COLORS.route, dashed: false },
  { key: "shortest", label: "Mais curta em metros", color: COLORS.shortest, dashed: true },
  { key: "no_expressway", label: "Sem via expressa", color: COLORS.noExpressway, dashed: true },
] as const;

const lngLat = (p: Point): LngLat => [p.lon, p.lat];

function stageOf(status: string | undefined): Stage {
  if (status === "a_caminho_da_loja") return "loja";
  if (status === "em_rota") return "cliente";
  return "fixo";
}

function signed(value: number, format: (n: number) => string, epsilon: number): string {
  if (Math.abs(value) < epsilon) return format(0);
  return `${value > 0 ? "+" : "−"}${format(Math.abs(value))}`;
}


function Heading({ children }: { children: string }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{children}</h3>;
}

function RouteTable({ alternatives }: { alternatives: RouteAlternatives | null }) {
  const chosen = alternatives?.fastest;
  const diff = (option: RouteOption) => {
    if (!chosen || option === chosen) return ["—", ""];
    if (Math.abs(option.seconds - chosen.seconds) < 0.5 && Math.abs(option.meters - chosen.meters) < 1) {
      return ["igual à escolhida", ""];
    }
    return [
      signed(option.seconds - chosen.seconds, formatDuration, 0.5),
      signed(option.meters - chosen.meters, formatDistance, 1),
    ];
  };
  return (
    <table className="mt-2 w-full text-xs">
      <thead>
        <tr className="text-left text-[11px] text-zinc-500">
          <th className="pb-1 font-normal">Rota</th>
          <th className="pb-1 text-right font-normal">Tempo</th>
          <th className="pb-1 pl-2 text-right font-normal">Distância</th>
          <th className="pb-1 pl-2 text-right font-normal">vs. escolhida</th>
        </tr>
      </thead>
      <tbody>
        {ALTERNATIVES.map((alt) => {
          const option = alternatives?.[alt.key];
          const [time, distance] = option ? diff(option) : ["", ""];
          return (
            <tr key={alt.key} data-testid={`alt-${alt.key}`} className="border-t border-white/5 align-top">
              <td className="py-1.5 pr-2">
                <span className="flex items-center gap-2 text-zinc-200">
                  <LineSample color={alt.color} dashed={alt.dashed} />
                  {alt.label}
                </span>
              </td>
              {option ? (
                <>
                  <td className="py-1.5 text-right tabular-nums text-zinc-100">{formatDuration(option.seconds)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-zinc-300">{formatDistance(option.meters)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-zinc-400">
                    {time}
                    {distance && <span className="block">{distance}</span>}
                  </td>
                </>
              ) : (
                <td colSpan={3} className="py-1.5 text-right text-zinc-500">
                  {alternatives ? "sem rota possível sem via expressa" : "…"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OfferCard({ offer, index }: { offer: Offer; index: number }) {
  const { candidates } = offer;
  const fastest = candidates[0];
  const nearest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, c) => (!best || c.distance_m < best.distance_m ? c : best),
    undefined,
  );
  const nearestRank = nearest ? candidates.indexOf(nearest) + 1 : 0;
  const shown = candidates.slice(0, SHOWN_CANDIDATES);
  return (
    <div className="mt-2 rounded-lg border border-white/10 px-3 py-2" data-testid="oferta">
      <p className="text-[11px] text-zinc-500">
        Oferta {index} · raio {formatDistance(offer.radius_m)} · {formatClock(offer.created_at, true)}
      </p>
      <p className="mt-0.5 text-xs text-zinc-200">
        Para o entregador #{offer.courier_id}, a {formatDuration(offer.eta_seconds)} da loja:{" "}
        <span className={offer.status === "aceita" ? "text-origin" : offer.status === "pendente" ? "text-zinc-300" : "text-target"}>
          {OUTCOMES[offer.status]}
        </span>
      </p>
      {candidates.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-zinc-500" data-testid="sem-candidatos">
          sem dados dos candidatos (pedido anterior a esta versão)
        </p>
      ) : (
        <>
          <ol className="mt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 gap-y-0.5 text-xs" data-testid="candidatos">
            <li className="contents text-[11px] text-zinc-500">
              <span>Pos.</span>
              <span>Entregador</span>
              <span className="text-right">pelas ruas</span>
              <span className="text-right">linha reta</span>
            </li>
            {shown.map((c, i) => {
              const recipient = c.courier_id === offer.courier_id;
              return (
                <li key={c.courier_id} className={`contents ${recipient ? "text-zinc-100" : "text-zinc-400"}`}>
                  <span className="tabular-nums">{i + 1}º</span>
                  <span className="truncate">
                    #{c.courier_id}
                    {recipient && <span className="text-route"> · recebeu</span>}
                    {c === nearest && nearest !== fastest && <span className="text-zinc-500"> · mais perto</span>}
                  </span>
                  <span className="text-right tabular-nums">{formatDuration(c.eta_seconds)}</span>
                  <span className="text-right tabular-nums">{formatMeters(c.distance_m)}</span>
                </li>
              );
            })}
          </ol>
          {candidates.length > shown.length && (
            <p className="mt-1 text-[11px] text-zinc-500">+{candidates.length - shown.length} candidatos mais lentos</p>
          )}
          {fastest && nearest && nearest !== fastest && (
            <p className="mt-2 rounded-md border border-route/40 bg-route/10 px-2 py-1.5 text-[11px] leading-snug text-zinc-200" data-testid="mais-perto-nao-mais-rapido">
              O #{nearest.courier_id} estava mais perto em linha reta ({formatMeters(nearest.distance_m)}, {nearestRank}º no
              ranking), mas levaria {formatDuration(nearest.eta_seconds)} pelas ruas:{" "}
              {formatDuration(nearest.eta_seconds - fastest.eta_seconds)} a mais que o #{fastest.courier_id}, a{" "}
              {formatMeters(fastest.distance_m)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface Props {
  orderId: number;
  order: LiveOrder | undefined;
  courierAt: LngLat | undefined;
  map: RefObject<MapLibre | null>;
  ready: boolean;
  onClose: () => void;
}

export default function OrderAnalysis({ orderId, order, courierAt, map, ready, onClose }: Props) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [routed, setRouted] = useState<{ stage: Stage; options: RouteAlternatives; at: string } | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const points = useRef<{ store?: Point; customer?: Point; courier?: LngLat }>({});
  const fitted = useRef(false);

  const active = order !== undefined;
  const liveKey = order ? `${order.status}:${order.courier_id ?? ""}` : "fora";
  const status = order?.status ?? detail?.status ?? "";
  const stage = stageOf(status);
  const store = order?.store ?? detail?.store;
  const customer = order?.customer ?? detail?.customer;
  const target = stage === "loja" ? store : customer;
  const canRoute = stage === "fixo" ? Boolean(store && customer) : Boolean(courierAt && target);
  const alternatives = routed?.stage === stage ? routed.options : null;

  useEffect(() => {
    points.current = { store, customer, courier: courierAt };
  });

  useEffect(() => {
    let alive = true;
    fetchOrder(orderId)
      .then((d) => alive && setDetail(d))
      .catch(() => undefined);
    fetchDispatch(orderId)
      .then((d) => {
        if (!alive) return;
        setDispatch(d);
        setDispatchError(null);
      })
      .catch((err: Error) => alive && setDispatchError(err.message));
    return () => {
      alive = false;
    };
  }, [orderId, liveKey]);

  useEffect(() => {
    if (!canRoute) return;
    const { store: s, customer: c, courier } = points.current;
    const from = stage === "fixo" ? s && lngLat(s) : courier;
    const to = stage === "loja" ? s && lngLat(s) : c && lngLat(c);
    if (!from || !to) return;
    const ctrl = new AbortController();
    fetchAlternatives(from, to, ctrl.signal)
      .then((options) => {
        setRouted({ stage, options, at: new Date().toISOString() });
        setRouteError(null);
      })
      .catch((err: Error) => {
        if (!ctrl.signal.aborted) setRouteError(err.message);
      });
    return () => ctrl.abort();
  }, [orderId, stage, canRoute]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchJourney(orderId)
        .then((j) => alive && setJourney(j))
        .catch(() => undefined);
    load();
    const timer = active ? window.setInterval(load, JOURNEY_EVERY_MS) : 0;
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [orderId, liveKey, active]);

  useEffect(() => {
    if (!ready) return;
    map.current?.getSource<GeoJSONSource>("alternativas")?.setData(alternativeFeatures(alternatives));
  }, [map, ready, alternatives]);

  useEffect(() => {
    if (!ready) return;
    map.current?.getSource<GeoJSONSource>("jornada")?.setData(journeyFeatures(journey));
  }, [map, ready, journey]);

  useEffect(() => {
    const m = map.current;
    return () => {
      m?.getSource<GeoJSONSource>("alternativas")?.setData(EMPTY);
      m?.getSource<GeoJSONSource>("jornada")?.setData(EMPTY);
    };
  }, [map]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !alternatives || fitted.current) return;
    fitted.current = true;
    const path = alternatives.fastest.path.coordinates;
    const bounds = new LngLatBounds(path[0], path[0]);
    for (const at of path) bounds.extend(at);
    const { store: s, customer: c } = points.current;
    if (s) bounds.extend(lngLat(s));
    if (c) bounds.extend(lngLat(c));
    const wide = window.innerWidth > 1100;
    m.fitBounds(bounds, {
      padding: wide ? { top: 48, bottom: 48, left: 400, right: 450 } : 32,
      maxZoom: 15.5,
      duration: 600,
    });
  }, [map, ready, alternatives]);

  const storeName = order?.store_name ?? detail?.store.name ?? "Pedido";
  const courierName = detail?.courier?.name ?? (order?.courier_id ? `Entregador #${order.courier_id}` : null);
  const offers = dispatch ? [...dispatch.offers].sort((a, b) => a.id - b.id) : [];

  return (
    <aside
      data-testid="analise"
      className="absolute right-4 top-4 flex max-h-[calc(100%-4.5rem)] w-[min(26rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-white/10 bg-panel/95 shadow-2xl backdrop-blur max-md:inset-x-4 max-md:bottom-12 max-md:top-auto max-md:max-h-[45%] max-md:w-auto"
    >
      <header className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Análise do pedido #{orderId}</p>
          <h2 className="mt-0.5 truncate text-base font-semibold text-zinc-100">{storeName}</h2>
          {status && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className={`h-2.5 w-3.5 rounded-sm ${statusFill(status)}`} />
              <span className={statusTone(status)}>{statusLabel(status)}</span>
              {courierName && <span className="text-zinc-400">· {courierName}</span>}
            </p>
          )}
          <Link to={`/pedido/${orderId}`} className="mt-2 inline-block text-xs text-route hover:underline">
            Abrir acompanhamento →
          </Link>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 rounded px-1.5 text-lg leading-none text-zinc-500 hover:text-zinc-200"
          aria-label="Fechar análise"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3">
        <section data-testid="analise-rotas">
          <Heading>Rota escolhida vs alternativas</Heading>
          <p className="mt-1 text-[11px] text-zinc-500">Trecho atual: {STAGE_TITLES[stage]}</p>
          {routeError ? (
            <p className="mt-2 text-xs text-target">{routeError}</p>
          ) : !canRoute && !alternatives ? (
            <p className="mt-2 text-xs text-zinc-500">Aguardando a posição do entregador…</p>
          ) : (
            <RouteTable alternatives={alternatives} />
          )}
          {alternatives && routed && (
            <p className="mt-1 text-[11px] text-zinc-600">
              Calculado às {formatClock(routed.at, true)}; recalcula quando a etapa muda.
            </p>
          )}
        </section>

        <section data-testid="analise-despacho">
          <Heading>Por que esse entregador</Heading>
          {dispatchError ? (
            <p className="mt-2 text-xs text-target">{dispatchError}</p>
          ) : !dispatch ? (
            <p className="mt-2 text-xs text-zinc-500">Carregando as ofertas…</p>
          ) : offers.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">Nenhuma oferta enviada ainda.</p>
          ) : (
            offers.map((offer, i) => <OfferCard key={offer.id} offer={offer} index={i + 1} />)
          )}
        </section>

        <section data-testid="analise-jornada">
          <Heading>Rota prevista vs andada</Heading>
          {LEGS.map((leg) => {
            const plan = journey?.plan[leg];
            const off = deviation(journey?.track[leg], plan?.path);
            const done = LEG_DONE[leg].includes(status) || (leg === "loja" && Boolean(journey?.plan.cliente));
            return (
              <div key={leg} className="mt-2 text-xs" data-testid={`trecho-${leg}`}>
                <p className="flex items-center gap-1.5 text-zinc-200">
                  <LineSample color={LEG_COLORS[leg]} dashed />
                  <LineSample color={LEG_COLORS[leg]} />
                  {LEG_TITLES[leg]}
                </p>
                <p className="mt-0.5 pl-[2.6rem] tabular-nums text-zinc-400">
                  {!journey ? (
                    "…"
                  ) : !plan ? (
                    "ainda não começou"
                  ) : (
                    <>
                      {done ? "" : active ? "em andamento · " : "interrompido · "}
                      prevista {formatDistance(plan.meters)} · desvio máximo{" "}
                      <span className="text-zinc-100" data-testid={`desvio-${leg}`}>
                        {Math.round(off.max)} m
                      </span>{" "}
                      · {off.inside} de {off.total} posições a até {OFF_ROUTE_METERS} m da rota
                    </>
                  )}
                </p>
              </div>
            );
          })}
        </section>

        <p className="-mt-3 text-[11px] leading-snug text-zinc-600">
          Desvio é a distância de cada posição recebida até a rota prevista; o maior valor diz se o entregador saiu do caminho.
        </p>

        <section className="border-t border-white/10 pt-3">
          <Heading>Legenda das linhas</Heading>
          <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
            {ALTERNATIVES.map((alt) => (
              <li key={alt.key} className="flex items-center gap-2">
                <LineSample color={alt.color} dashed={alt.dashed} />
                {alt.label}, do trecho atual
              </li>
            ))}
            {LEGS.map((leg) => (
              <li key={leg} className="flex items-center gap-2">
                <LineSample color={LEG_COLORS[leg]} dashed />
                <LineSample color={LEG_COLORS[leg]} />
                {LEG_TITLES[leg]}: prevista tracejada, andada sólida
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
