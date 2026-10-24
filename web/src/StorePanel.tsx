import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  { key: "prontos", title: "Prontos", empty: "Nenhum pedido esperando no balcão." },
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

const primary =
  "rounded-md bg-route px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-route/90 disabled:cursor-not-allowed disabled:opacity-50";
const secondary =
  "rounded-md border border-white/15 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";
const danger =
  "rounded-md border border-target/50 px-2.5 py-1.5 text-xs text-target hover:bg-target/10 disabled:cursor-not-allowed disabled:opacity-50";

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

function OrderCard({ order, store, now, busy, error, prep, onPrep, onAccept, onReject, onReady }: CardProps) {
  const column = columnOf(order);
  const meters = metersBetween([store.lon, store.lat], [order.customer_lon, order.customer_lat]);
  let body: ReactNode = null;

  if (column === "novos") {
    const left = Date.parse(order.created_at) + AUTO_REFUSE_MS - now;
    body = (
      <>
        <p className={`mt-1 text-[11px] tabular-nums ${left < 60_000 ? "text-target" : "text-zinc-500"}`} data-testid="recusa-automatica">
          {left > 0 ? `Recusa automática em ${countdown(left)}` : "Recusando por falta de resposta…"}
        </p>
        <label className="mt-2 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          Tempo de preparo
          <select
            value={prep}
            onChange={(e) => onPrep(Number(e.target.value))}
            disabled={busy}
            aria-label={`Tempo de preparo do pedido #${order.id}`}
            className="rounded-md border border-white/15 bg-ink px-1.5 py-1 text-xs text-zinc-100"
          >
            {prepOptions(store.default_prep_minutes).map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" className={danger} disabled={busy} onClick={onReject}>
            Recusar
          </button>
          <button type="button" className={primary} disabled={busy} onClick={onAccept}>
            Aceitar
          </button>
        </div>
      </>
    );
  } else if (column === "preparo") {
    body = (
      <>
        <p className="mt-1 text-xs text-zinc-300" data-testid="situacao-entregador">
          {courierState(order)}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-500">
            {order.prep_minutes !== null ? `Preparo de ${order.prep_minutes} min` : ""}
          </span>
          <button type="button" className={primary} disabled={busy} onClick={onReady}>
            Marcar pronto
          </button>
        </div>
      </>
    );
  } else if (column === "prontos") {
    body = (
      <>
        <p className="mt-1 text-xs text-zinc-300" data-testid="situacao-entregador">
          {courierState(order)}
        </p>
        {order.ready_at && <p className="mt-0.5 text-[11px] text-zinc-500">Pronto {since(order.ready_at, now)}</p>}
      </>
    );
  } else {
    body = (
      <>
        <p className={`mt-1 text-xs ${statusTone(order.status)}`}>{OUT_LABELS[order.status] ?? order.status}</p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          {order.courier_name ?? "Sem entregador"} · às {formatClock(order.updated_at)}
        </p>
      </>
    );
  }

  return (
    <li
      className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
      data-testid="card-pedido-loja"
      data-status={order.status}
      data-pedido={order.id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Link to={`/pedido/${order.id}`} className="text-sm font-semibold tabular-nums text-zinc-100 hover:underline">
          #{order.id}
        </Link>
        <span className="text-[11px] tabular-nums text-zinc-500">{since(order.created_at, now)}</span>
      </div>
      <p className="text-[11px] text-zinc-400">Cliente a {formatDistance(meters)}</p>
      {body}
      {error && <p className="mt-2 text-[11px] text-target">{error}</p>}
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
          <p className="text-base font-semibold text-zinc-100">{missing ? "Loja não encontrada" : loadError}</p>
          <Link to="/loja" className="mt-2 inline-block text-sm text-route hover:underline">
            Escolher outra loja
          </Link>
        </div>
      </div>
    );
  }

  if (!store) {
    return <p className="p-6 text-sm text-zinc-400">Carregando a loja…</p>;
  }

  const grouped: Record<ColumnKey, StoreOrder[]> = { novos: [], preparo: [], prontos: [], sairam: [] };
  for (const order of orders ?? []) grouped[columnOf(order)].push(order);
  for (const key of ["novos", "preparo", "prontos"] as const) grouped[key].sort((a, b) => a.id - b.id);
  grouped.sairam.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <header className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · loja #{store.id}</p>
            <h1 className="mt-1 text-lg font-semibold text-zinc-100">{store.name}</h1>
            <p className="mt-1 text-xs text-zinc-400">
              Preparo padrão de {store.default_prep_minutes} min ·{" "}
              <Link to="/loja" className="text-route hover:underline">
                trocar de loja
              </Link>
            </p>
          </header>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch lg:max-w-xl">
            <label className="flex flex-1 cursor-pointer items-start justify-between gap-3 rounded-lg border border-white/10 bg-panel px-3 py-2">
              <span>
                <span className="block text-sm text-zinc-100">Operar na mão</span>
                <span className="block text-xs text-zinc-400">
                  {store.manual
                    ? "Os pedidos novos esperam você aceitar, recusar e marcar pronto."
                    : "Desligado, o simulador aceita e prepara sozinho os pedidos novos desta loja."}
                </span>
                {manualError && <span className="mt-1 block text-xs text-target">{manualError}</span>}
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={store.manual}
                disabled={switching}
                onChange={(e) => toggleManual(e.target.checked)}
                className="mt-1 size-4 shrink-0 accent-route"
              />
            </label>
            <div className="flex flex-col justify-center gap-1 rounded-lg border border-white/10 bg-panel px-3 py-2 sm:w-56">
              <button type="button" className={secondary} disabled={creating} onClick={testOrder}>
                {creating ? "Gerando…" : "Gerar pedido de teste"}
              </button>
              <p
                className={`min-h-4 text-[11px] ${notice?.tone === "error" ? "text-target" : "text-zinc-400"}`}
                data-testid="aviso-pedido-teste"
                aria-live="polite"
              >
                {notice?.text ?? "Cliente sorteado entre 300 m e 4 km."}
              </p>
            </div>
          </div>
        </div>

        {ordersError && <p className="mt-4 text-sm text-target">{ordersError}</p>}

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((column) => {
            const list = grouped[column.key];
            return (
              <section
                key={column.key}
                className="flex min-h-40 flex-col rounded-xl border border-white/10 bg-panel"
                data-testid={`coluna-${column.key}`}
                aria-label={column.title}
              >
                <header className="flex items-baseline justify-between border-b border-white/10 px-3 py-2">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{column.title}</h2>
                  <span className="text-sm font-semibold tabular-nums text-zinc-100">{orders ? list.length : "—"}</span>
                </header>
                {orders === null ? (
                  <p className="px-3 py-3 text-xs text-zinc-500">Carregando…</p>
                ) : list.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-zinc-500">{column.empty}</p>
                ) : (
                  <ul className="flex flex-col gap-2 p-2">
                    {list.map((order) => (
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
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
