import { useEffect, useState } from "react";
import { fetchCouriers, type CourierSummary } from "./api";
import { Link } from "./router";

const STATUS_LABELS: Record<CourierSummary["status"], string> = {
  offline: "offline",
  livre: "livre",
  ocupado: "em entrega",
};

const STATUS_DOTS: Record<CourierSummary["status"], string> = {
  offline: "bg-zinc-500",
  livre: "bg-origin",
  ocupado: "bg-route",
};

function CourierList({ couriers, testId }: { couriers: CourierSummary[]; testId: string }) {
  return (
    <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10 bg-panel">
      {couriers.map((c) => (
        <li key={c.id}>
          <Link
            to={`/entregador/${c.id}`}
            data-testid={testId}
            data-id={c.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-white/5"
          >
            <span className="min-w-0 truncate text-zinc-100">{c.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
              <span className={`size-2 rounded-full ${STATUS_DOTS[c.status]}`} />
              {STATUS_LABELS[c.status]}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function CourierPicker() {
  const [mine, setMine] = useState<CourierSummary[] | null>(null);
  const [offline, setOffline] = useState<CourierSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Entregador · GDrive";
    let alive = true;
    Promise.all([fetchCouriers({ human: true }), fetchCouriers({ status: "offline", limit: 12 })])
      .then(([humans, idle]) => {
        if (!alive) return;
        const taken = new Set(humans.map((c) => c.id));
        setMine(humans);
        setOffline(idle.filter((c) => !taken.has(c.id)));
      })
      .catch((err: Error) => alive && setError(`A lista não carregou: ${err.message}`));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-md px-4 py-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">GDrive · entregador</p>
        <h1 className="mt-1 text-lg font-semibold text-zinc-100">Pilote um entregador pelo celular</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Escolha um entregador parado. Você decide se aceita, coleta e entrega; o deslocamento segue a rota em piloto
          automático.
        </p>

        {error && <p className="mt-4 text-sm text-target">{error}</p>}
        {!error && (mine === null || offline === null) && <p className="mt-4 text-sm text-zinc-400">Carregando…</p>}

        {mine && mine.length > 0 && (
          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Já controlados pelo celular</h2>
            <CourierList couriers={mine} testId="entregador-humano" />
          </section>
        )}

        {offline && (
          <section className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Offline, prontos para assumir</h2>
            {offline.length > 0 ? (
              <CourierList couriers={offline} testId="entregador-offline" />
            ) : (
              <p className="mt-2 text-sm text-zinc-400">Nenhum entregador offline agora.</p>
            )}
          </section>
        )}

        <p className="mt-6 text-xs text-zinc-500">
          Os demais entregadores estão com o simulador e andam sozinhos pela cidade.
        </p>
      </div>
    </div>
  );
}
