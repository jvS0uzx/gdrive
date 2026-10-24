import { useEffect, useState } from "react";
import { fetchHistory, type HistoryPage } from "./api";
import { formatClock, formatDistance, formatDuration, formatInt } from "./format";
import { Link, navigate } from "./router";

const PAGE_SIZE = 50;

const fit = "w-px whitespace-nowrap px-3 py-2.5";

const COLUMNS = {
  pedido: { label: "Pedido", className: fit },
  loja: { label: "Loja", className: "w-full max-w-0 truncate px-3 py-2.5" },
  entregador: { label: "Entregador", className: `${fit} hidden md:table-cell` },
  feito: { label: "Feito às", className: `${fit} hidden lg:table-cell` },
  entregue: { label: "Entregue às", className: fit },
  duracao: { label: "Duração", className: `${fit} hidden text-right sm:table-cell` },
  distancia: { label: "Distância", className: `${fit} hidden text-right md:table-cell` },
  prazo: { label: "Prazo", className: fit },
  alertas: { label: "Alertas", className: `${fit} hidden text-right lg:table-cell` },
};

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
      <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <header>
            <h1 className="text-[17px] font-semibold tracking-tight">Entregas feitas</h1>
            <p className="meta mt-1">Abra uma entrega para rever o trajeto no mapa.</p>
          </header>
          <div className="flex items-center gap-2">
            <span className="num mr-1 text-xs text-muted" data-testid="paginacao">
              {page ? `${formatInt(first)}–${formatInt(last)} de ${formatInt(total)}` : "—"}
            </span>
            <button
              type="button"
              className="btn"
              disabled={loading || offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Mais recentes
            </button>
            <button
              type="button"
              className="btn"
              disabled={loading || offset + PAGE_SIZE >= total}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Mais antigas
            </button>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-target">{error}</p>}

        <div className="-mx-3 mt-6">
          <table className="w-full text-left text-[13px]" data-testid="tabela-historico">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                {Object.values(COLUMNS).map((c) => (
                  <th key={c.label} scope="col" className={`${c.className} pb-2 pt-0 font-medium`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={`transition-opacity ${loading && page ? "opacity-60" : ""}`}>
              {page?.items.map((item) => (
                <tr
                  key={item.id}
                  data-testid="linha-historico"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a")) return;
                    navigate(`/historico/${item.id}`);
                  }}
                  className="cursor-pointer border-b border-line transition-colors hover:bg-panel"
                >
                  <td className={COLUMNS.pedido.className}>
                    <Link to={`/historico/${item.id}`} className="mono text-strong underline-offset-2 hover:underline">
                      #{item.id}
                    </Link>
                  </td>
                  <td className={`${COLUMNS.loja.className} text-strong`}>{item.store_name}</td>
                  <td className={`${COLUMNS.entregador.className} mono text-muted`}>
                    {item.courier_id !== null ? `#${item.courier_id}` : "—"}
                  </td>
                  <td className={`${COLUMNS.feito.className} mono text-muted`}>{formatClock(item.created_at)}</td>
                  <td className={`${COLUMNS.entregue.className} mono text-muted`}>
                    {item.delivered_at ? formatClock(item.delivered_at) : "—"}
                  </td>
                  <td className={`${COLUMNS.duracao.className} num text-muted`}>
                    {item.seconds !== null ? formatDuration(item.seconds) : "—"}
                  </td>
                  <td className={`${COLUMNS.distancia.className} num text-muted`}>
                    {item.meters !== null ? formatDistance(item.meters) : "—"}
                  </td>
                  <td className={COLUMNS.prazo.className}>
                    {item.late === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className={item.late ? "text-target" : "text-origin"}>{item.late ? "atrasado" : "no prazo"}</span>
                    )}
                  </td>
                  <td className={`${COLUMNS.alertas.className} num ${item.alerts > 0 ? "text-strong" : "text-faint"}`}>
                    {item.alerts > 0 ? formatInt(item.alerts) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page && page.items.length === 0 && <p className="meta px-3 py-4">Nenhuma entrega concluída ainda.</p>}
          {!page && !error && <p className="meta px-3 py-4">Carregando o histórico…</p>}
        </div>
      </div>
    </div>
  );
}
