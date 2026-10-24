import { useEffect, useState } from "react";
import { fetchStores, type StoreSummary } from "./api";
import { Link } from "./router";

const SEARCH_DELAY_MS = 250;

export default function StorePicker() {
  const [query, setQuery] = useState("");
  const [stores, setStores] = useState<StoreSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Loja · GDrive";
  }, []);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      fetchStores(query)
        .then((list) => {
          if (!alive) return;
          setError(null);
          setStores(list);
        })
        .catch((err: Error) => alive && setError(`A busca falhou: ${err.message}`));
    }, SEARCH_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-4 py-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · loja</p>
        <h1 className="mt-1 text-lg font-semibold text-zinc-100">Qual loja você vai operar?</h1>
        <p className="mt-1 text-sm text-zinc-400">
          O painel mostra os pedidos da loja ao vivo. Você aceita, recusa e marca o pedido como pronto.
        </p>

        <label className="mt-5 block">
          <span className="sr-only">Buscar loja</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar pelo nome da loja"
            aria-label="Buscar loja"
            autoFocus
            className="w-full rounded-lg border border-white/10 bg-panel px-3 py-2.5 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-route/60 focus:outline-none sm:text-sm"
          />
        </label>

        {error && <p className="mt-3 text-sm text-target">{error}</p>}

        {stores === null && !error ? (
          <p className="mt-4 text-sm text-zinc-400">Carregando lojas…</p>
        ) : stores && stores.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-400">Nenhuma loja com esse nome.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10 bg-panel" data-testid="lista-lojas">
            {stores?.map((store) => (
              <li key={store.id}>
                <Link
                  to={`/loja/${store.id}`}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-white/5"
                >
                  <span className="min-w-0 truncate text-zinc-100">{store.name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                    {store.manual && (
                      <span className="rounded border border-route/40 px-1.5 py-0.5 text-[10px] text-route">na mão</span>
                    )}
                    <span className="tabular-nums">#{store.id}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
