import { useEffect, useState } from "react";
import { fetchHistory, type HistoryPage } from "./api";
import { formatClock, formatDistance, formatDuration, formatInt } from "./format";
import { Link, navigate } from "./router";

const PAGE_SIZE = 50;

const HEADERS = ["Pedido", "Loja", "Entregador", "Feito às", "Entregue às", "Duração", "Distância", "Prazo", "Alertas"];

export default function History() {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Histórico · GDrive";
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchHistory(PAGE_SIZE, offset)
      .then((p) => {
        if (!alive) return;
        setError(null);
        setPage(p);
      })
      .catch((err: Error) => alive && setError(`O histórico não carregou: ${err.message}`))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [offset]);

  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <header>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · histórico</p>
            <h1 className="mt-1 text-lg font-semibold text-zinc-100">Entregas feitas</h1>
            <p className="mt-1 text-sm text-zinc-400">Abra uma entrega para rever o trajeto do entregador no mapa.</p>
          </header>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="tabular-nums" data-testid="paginacao">
              {page ? `${formatInt(first)}–${formatInt(last)} de ${formatInt(total)}` : "—"}
            </span>
            <button
              type="button"
              className="rounded-md border border-white/15 px-2.5 py-1 text-zinc-200 hover:bg-white/5 disabled:opacity-40"
              disabled={loading || offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Mais recentes
            </button>
            <button
              type="button"
              className="rounded-md border border-white/15 px-2.5 py-1 text-zinc-200 hover:bg-white/5 disabled:opacity-40"
              disabled={loading || offset + PAGE_SIZE >= total}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Mais antigas
            </button>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-target">{error}</p>}

        <div className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-panel">
          <table className="w-full min-w-[52rem] text-left text-xs" data-testid="tabela-historico">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                {HEADERS.map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={loading && page ? "opacity-60" : undefined}>
              {page?.items.map((item) => (
                <tr
                  key={item.id}
                  data-testid="linha-historico"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a")) return;
                    navigate(`/historico/${item.id}`);
                  }}
                  className="cursor-pointer border-b border-white/5 last:border-0 hover:bg-white/5"
                >
                  <td className="px-3 py-2">
                    <Link to={`/historico/${item.id}`} className="font-semibold tabular-nums text-route hover:underline">
                      #{item.id}
                    </Link>
                  </td>
                  <td className="max-w-56 truncate px-3 py-2 text-zinc-200">{item.store_name}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">
                    {item.courier_id !== null ? `#${item.courier_id}` : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">{formatClock(item.created_at)}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">
                    {item.delivered_at ? formatClock(item.delivered_at) : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">
                    {item.seconds !== null ? formatDuration(item.seconds) : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">
                    {item.meters !== null ? formatDistance(item.meters) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {item.late === null ? (
                      <span className="text-zinc-500">—</span>
                    ) : item.late ? (
                      <span className="rounded border border-target/40 bg-target/10 px-1.5 py-0.5 text-[11px] text-target">
                        atrasado
                      </span>
                    ) : (
                      <span className="rounded border border-origin/30 bg-origin/10 px-1.5 py-0.5 text-[11px] text-origin">
                        no prazo
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-2 tabular-nums ${item.alerts > 0 ? "text-route" : "text-zinc-500"}`}>
                    {item.alerts > 0 ? formatInt(item.alerts) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page && page.items.length === 0 && (
            <p className="px-3 py-4 text-sm text-zinc-400">Nenhuma entrega concluída ainda.</p>
          )}
          {!page && !error && <p className="px-3 py-4 text-sm text-zinc-400">Carregando o histórico…</p>}
        </div>
      </div>
    </div>
  );
}
