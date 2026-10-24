import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTestOrder,
  fetchStore,
  fetchStoreOrders,
  setStoreManual,
  storeAccept,
  storeReady,
  storeReject,
  type StoreInfo,
  type StoreOrder,
} from "./api";
import { metersBetween } from "./cityMap";
import { formatClock, formatDistance } from "./format";
import { statusTone } from "./labels";
import { Link } from "./router";

const POLL_MS = 2000;
const AUTO_REFUSE_MS = 5 * 60_000;
const PREP_CHOICES = [5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60];
const KITCHEN = new Set(["em_preparo", "a_caminho_da_loja", "na_loja"]);

type ColumnKey = "novos" | "preparo" | "prontos" | "sairam";

const COLUMNS: { key: ColumnKey; title: string; empty: string }[] = [
  { key: "novos", title: "Novos", empty: "Nenhum pedido esperando resposta." },
  { key: "preparo", title: "Em preparo", empty: "Nada na cozinha agora." },
  { key: "prontos", title: "Prontos", empty: "Nada esperando no balcão." },
  { key: "sairam", title: "Saíram", empty: "Nenhum pedido saiu ainda." },
];

const OUT_LABELS: Record<string, string> = {
  em_rota: "Saiu para entrega",
  no_cliente: "Entregador no cliente",
  entregue: "Entregue",
  recusado: "Recusado",
  cancelado: "Cancelado",
};

function columnOf(order: StoreOrder): ColumnKey {
  if (order.status === "aguardando_loja") return "novos";
  if (KITCHEN.has(order.status)) return order.ready_at ? "prontos" : "preparo";
  return "sairam";
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  return `há ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function courierState(order: StoreOrder): string {
  const name = order.courier_name ?? (order.courier_id !== null ? `Entregador #${order.courier_id}` : null);
  if (order.status === "a_caminho_da_loja") return `${name ?? "Entregador"} a caminho`;
  if (order.status === "na_loja") return `${name ?? "Entregador"} na loja`;
  return "Procurando entregador";
}

function prepOptions(fallback: number): number[] {
  return [...new Set([...PREP_CHOICES, fallback])].sort((a, b) => a - b);
}

const toggle =
  "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-line transition-colors before:absolute before:left-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-muted before:transition-transform checked:bg-strong checked:before:translate-x-4 checked:before:bg-ink disabled:cursor-not-allowed disabled:opacity-50";

interface CardProps {
  order: StoreOrder;
  store: StoreInfo;
  now: number;
  busy: boolean;
  error: string | null;
  prep: number;
  onPrep: (minutes: number) => void;
  onAccept: () => void;
  onReject: () => void;
  onReady: () => void;
}

function OrderId({ id }: { id: number }) {
  return (
    <Link to={`/pedido/${id}`} className="mono text-[13px] font-medium text-strong hover:underline">
      #{id}
    </Link>
  );
}

function OutRow({ order, error }: { order: StoreOrder; error: string | null }) {
  return (
    <li
      className="border-t border-line px-1 py-2.5 first:border-t-0"
      data-testid="card-pedido-loja"
      data-status={order.status}
      data-pedido={order.id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <OrderId id={order.id} />
        <span className={`text-xs ${statusTone(order.status)}`}>{OUT_LABELS[order.status] ?? order.status}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-faint">
        <span className="truncate">{order.courier_name ?? "Sem entregador"}</span>
        <span className="mono shrink-0">{formatClock(order.updated_at)}</span>
      </div>
      {error && <p className="mt-1.5 text-xs text-target">{error}</p>}
    </li>
  );
}

function OrderCard({ order, store, now, busy, error, prep, onPrep, onAccept, onReject, onReady }: CardProps) {
  const column = columnOf(order);
  const meters = metersBetween([store.lon, store.lat], [order.customer_lon, order.customer_lat]);
  const left = Date.parse(order.created_at) + AUTO_REFUSE_MS - now;

  return (
    <li
      className="rounded-md bg-raised px-3 py-2.5"
      data-testid="card-pedido-loja"
      data-status={order.status}
      data-pedido={order.id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <OrderId id={order.id} />
        <span className="num text-xs text-faint">{since(order.created_at, now)}</span>
      </div>
      <p className="text-xs text-muted">Cliente a {formatDistance(meters)}</p>

      {column === "novos" && (
        <>
          <p className={`mt-2 text-xs ${left < 60_000 ? "text-target" : "text-muted"}`} data-testid="recusa-automatica">
            {left > 0 ? (
              <>
                Recusa automática em <span className="mono">{countdown(left)}</span>
              </>
            ) : (
              "Recusando por falta de resposta…"
            )}
          </p>
          <label className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
            Tempo de preparo
            <select
              value={prep}
              onChange={(e) => onPrep(Number(e.target.value))}
              disabled={busy}
              aria-label={`Tempo de preparo do pedido #${order.id}`}
              className="num h-7 rounded-md border border-line bg-ink px-1.5 text-xs text-strong"
            >
              {prepOptions(store.default_prep_minutes).map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={onReject}>
              Recusar
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={onAccept}>
              Aceitar
            </button>
          </div>
        </>
      )}

      {column === "preparo" && (
        <>
          <p className="mt-2 text-xs text-strong" data-testid="situacao-entregador">
            {courierState(order)}
          </p>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-xs text-faint">
              {order.prep_minutes !== null && (
                <>
                  Preparo de <span className="num">{order.prep_minutes}</span> min
                </>
              )}
            </span>
            <button type="button" className="btn" disabled={busy} onClick={onReady}>
              Marcar pronto
            </button>
          </div>
        </>
      )}

      {column === "prontos" && (
        <>
          <p className="mt-2 text-xs text-strong" data-testid="situacao-entregador">
            {courierState(order)}
          </p>
          {order.ready_at && <p className="mt-0.5 text-xs text-faint">Pronto {since(order.ready_at, now)}</p>}
        </>
      )}

      {error && <p className="mt-2 text-xs text-target">{error}</p>}
    </li>
  );
}

export default function StorePanel({ id }: { id: number }) {
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orders, setOrders] = useState<StoreOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [prep, setPrep] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [switching, setSwitching] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const requests = useRef(0);
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    fetchStore(id)
      .then((s) => {
        if (!alive) return;
        if (!s) setMissing(true);
        else setStore(s);
      })
      .catch((err: Error) => alive && setLoadError(`A loja não carregou: ${err.message}`));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    document.title = store ? `${store.name} · Loja · GDrive` : "Loja · GDrive";
  }, [store]);

  const refresh = useCallback(() => {
    const n = ++requests.current;
    fetchStoreOrders(id)
      .then((list) => {
        if (n !== requests.current) return;
        setOrdersError(null);
        setOrders(list);
      })
      .catch((err: Error) => {
        if (n === requests.current) setOrdersError(`Os pedidos não carregaram: ${err.message}`);
      });
  }, [id]);

  useEffect(() => {
    if (missing) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [missing, refresh]);

  const act = async (orderId: number, action: () => Promise<unknown>) => {
    setBusy((s) => new Set(s).add(orderId));
    setErrors((e) => {
      const next = { ...e };
      delete next[orderId];
      return next;
    });
    try {
      await action();
    } catch (err) {
      setErrors((e) => ({ ...e, [orderId]: (err as Error).message }));
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(orderId);
        return next;
      });
      refresh();
    }
  };

  const toggleManual = async (manual: boolean) => {
    setSwitching(true);
    setManualError(null);
    setStore((s) => (s ? { ...s, manual } : s));
    try {
      setStore(await setStoreManual(id, manual));
    } catch (err) {
      setStore((s) => (s ? { ...s, manual: !manual } : s));
      setManualError((err as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  const testOrder = async () => {
    setCreating(true);
    setNotice(null);
    try {
      const created = await createTestOrder(id);
      setNotice({ tone: "ok", text: `Pedido #${created.id} criado.` });
      refresh();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setCreating(false);
    }
  };

  if (missing || (!store && loadError)) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-[15px] font-semibold">{missing ? "Loja não encontrada" : loadError}</p>
          <Link to="/loja" className="link mt-2 inline-block text-sm">
            Escolher outra loja
          </Link>
        </div>
      </div>
    );
  }

  if (!store) {
    return <p className="meta p-6">Carregando a loja…</p>;
  }

  const grouped: Record<ColumnKey, StoreOrder[]> = { novos: [], preparo: [], prontos: [], sairam: [] };
  for (const order of orders ?? []) grouped[columnOf(order)].push(order);
  for (const key of ["novos", "preparo", "prontos"] as const) grouped[key].sort((a, b) => a.id - b.id);
  grouped.sairam.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto lg:overflow-hidden">
      <header className="dock flex shrink-0 flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:border-b">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold tracking-tight">{store.name}</h1>
          <p className="meta mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span>
              Loja <span className="mono">#{store.id}</span>
            </span>
            <span>
              Preparo padrão de <span className="num">{store.default_prep_minutes}</span> min
            </span>
            <Link to="/loja" className="link">
              Trocar de loja
            </Link>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              role="switch"
              checked={store.manual}
              disabled={switching}
              onChange={(e) => toggleManual(e.target.checked)}
              className={toggle}
            />
            <span>
              <span className="block text-[13px] font-medium">Operar na mão</span>
              <span className="meta block">
                {store.manual ? "Você aceita e marca pronto" : "O simulador responde pela loja"}
              </span>
            </span>
          </label>
          {manualError && <p className="text-xs text-target">{manualError}</p>}
          <div className="flex items-center gap-3">
            <button type="button" className="btn" disabled={creating} onClick={testOrder}>
              {creating ? "Gerando…" : "Gerar pedido de teste"}
            </button>
            <p
              className={`text-xs ${notice?.tone === "error" ? "text-target" : "text-muted"}`}
              data-testid="aviso-pedido-teste"
              aria-live="polite"
            >
              {notice?.text}
            </p>
          </div>
        </div>
      </header>

      {ordersError && <p className="px-4 py-2 text-sm text-target sm:px-6">{ordersError}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:min-h-0 lg:flex-1 lg:grid-cols-4">
        {COLUMNS.map((column) => {
          const list = grouped[column.key];
          return (
            <section
              key={column.key}
              className="flex flex-col border-t border-line md:odd:border-r lg:min-h-0 lg:border-r lg:border-t-0 lg:last:border-r-0"
              data-testid={`coluna-${column.key}`}
              aria-label={column.title}
            >
              <header className="flex items-baseline justify-between px-4 pb-2 pt-4 sm:px-5">
                <h2 className="section-title">{column.title}</h2>
                <span className={`num text-[13px] ${list.length > 0 ? "text-strong" : "text-faint"}`}>
                  {orders ? list.length : "—"}
                </span>
              </header>
              {orders === null ? (
                <p className="px-4 pb-5 text-xs text-faint sm:px-5">Carregando…</p>
              ) : list.length === 0 ? (
                <p className="px-4 pb-5 text-xs text-faint sm:px-5">{column.empty}</p>
              ) : (
                <ul
                  className={`flex flex-col px-3 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto sm:px-4 ${
                    column.key === "sairam" ? "" : "gap-2"
                  }`}
                >
                  {list.map((order) =>
                    column.key === "sairam" ? (
                      <OutRow key={order.id} order={order} error={errors[order.id] ?? null} />
                    ) : (
                      <OrderCard
                        key={order.id}
                        order={order}
                        store={store}
                        now={now}
                        busy={busy.has(order.id)}
                        error={errors[order.id] ?? null}
                        prep={prep[order.id] ?? store.default_prep_minutes}
                        onPrep={(minutes) => setPrep((p) => ({ ...p, [order.id]: minutes }))}
                        onAccept={() =>
                          act(order.id, () => storeAccept(id, order.id, prep[order.id] ?? store.default_prep_minutes))
                        }
                        onReject={() => act(order.id, () => storeReject(id, order.id))}
                        onReady={() => act(order.id, () => storeReady(id, order.id))}
                      />
                    ),
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
