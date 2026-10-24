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
      <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-8 sm:px-6">
        <h1 className="text-[17px] font-semibold tracking-tight">Qual loja você vai operar?</h1>
        <p className="meta mt-1">O painel abre com os pedidos da loja ao vivo.</p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar pelo nome"
          aria-label="Buscar loja"
          autoFocus
          className="mt-6 h-10 w-full rounded-md border border-line bg-panel px-3 text-base text-strong transition-colors placeholder:text-faint focus:border-faint focus:outline-none sm:text-sm"
        />

        {error && <p className="mt-3 text-sm text-target">{error}</p>}

        {stores === null && !error ? (
          <p className="meta mt-4">Carregando lojas…</p>
        ) : stores && stores.length === 0 ? (
          <p className="meta mt-4">Nenhuma loja com esse nome.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line" data-testid="lista-lojas">
            {stores?.map((store) => (
              <li key={store.id}>
                <Link
                  to={`/loja/${store.id}`}
                  className="flex items-baseline gap-3 px-1 py-2.5 text-sm transition-colors hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate text-strong">{store.name}</span>
                  {store.manual && <span className="shrink-0 text-xs text-muted">na mão</span>}
                  <span className="mono w-12 shrink-0 text-right text-xs text-faint">#{store.id}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
