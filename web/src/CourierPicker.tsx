import { useEffect, useState } from "react";
import { fetchCouriers, type CourierSummary } from "./api";
import { COLORS } from "./cityMap";
import { formatInt } from "./format";
import { Link } from "./router";

const STATUS_LABELS: Record<CourierSummary["status"], string> = {
  offline: "offline",
  livre: "livre",
  ocupado: "em entrega",
};

const STATUS_COLORS: Record<CourierSummary["status"], string> = {
  offline: "var(--color-faint)",
  livre: COLORS.free,
  ocupado: COLORS.busy,
};

function CourierList({ couriers, testId }: { couriers: CourierSummary[]; testId: string }) {
  return (
    <ul className="mt-2 divide-y divide-line border-y border-line">
      {couriers.map((c) => (
        <li key={c.id}>
          <Link
            to={`/entregador/${c.id}`}
            data-testid={testId}
            data-id={c.id}
            className="flex items-center gap-3 px-1 py-2.5 text-sm transition-colors hover:bg-raised"
          >
            <span className="min-w-0 flex-1 truncate text-strong">{c.name}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
              <span className="size-2 rounded-[2px]" style={{ background: STATUS_COLORS[c.status] }} />
              {STATUS_LABELS[c.status]}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Heading({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="section-title">{title}</h2>
      {count !== undefined && <span className="num text-xs text-muted">{formatInt(count)}</span>}
    </div>
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
      <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-8 sm:px-6">
        <h1 className="text-[17px] font-semibold tracking-tight">Pilote um entregador pelo celular</h1>
        <p className="meta mt-1">
          Escolha um entregador offline. Você aceita, coleta e entrega; o trajeto segue no piloto automático.
        </p>

        {error && <p className="mt-6 text-sm text-target">{error}</p>}
        {!error && (mine === null || offline === null) && <p className="meta mt-6">Carregando…</p>}

        {mine && mine.length > 0 && (
          <section className="mt-8">
            <Heading title="Pilotados pelo celular" count={mine.length} />
            <CourierList couriers={mine} testId="entregador-humano" />
          </section>
        )}

        {offline && (
          <section className="mt-8">
            <Heading title="Offline" />
            {offline.length > 0 ? (
              <CourierList couriers={offline} testId="entregador-offline" />
            ) : (
              <p className="meta mt-2">Nenhum entregador offline agora.</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
