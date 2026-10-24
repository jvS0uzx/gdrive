import { useEffect, useState } from "react";
import { fetchSim, simCommand, updateSim, type SimAction, type SimState } from "./api";

const RUSH_LEVELS = [1, 2, 3, 5];

const FAULTS: { action: SimAction; label: string; seconds: number; done: string }[] = [
  { action: "sem_sinal", label: "Derrubar o sinal", seconds: 60, done: "sem sinal por 60 s" },
  { action: "parar", label: "Parar", seconds: 90, done: "parado por 90 s" },
  { action: "desviar", label: "Desviar", seconds: 60, done: "desviando da rota" },
];

export function CourierFaults({ courierId }: { courierId: number }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const run = (fault: (typeof FAULTS)[number]) => {
    simCommand(courierId, fault.action, fault.seconds)
      .then(() => setMessage({ text: `#${courierId} ${fault.done}`, error: false }))
      .catch((err: Error) => setMessage({ text: err.message, error: true }));
  };
  return (
    <div data-testid="falhas">
      <div className="flex flex-wrap gap-1.5">
        {FAULTS.map((fault) => (
          <button
            key={fault.action}
            type="button"
            onClick={() => run(fault)}
            data-testid={`falha-${fault.action}`}
            className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/5"
          >
            {fault.label}
          </button>
        ))}
      </div>
      {message && (
        <p className={`mt-1 text-[11px] ${message.error ? "text-target" : "text-zinc-400"}`}>{message.text}</p>
      )}
    </div>
  );
}

export default function SimControls({ liveRain }: { liveRain: boolean | undefined }) {
  const [state, setState] = useState<SimState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchSim()
      .then((s) => alive && setState(s))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (liveRain === undefined) return;
    setState((s) => (s && s.rain !== liveRain ? { ...s, rain: liveRain } : s));
  }, [liveRain]);

  const change = (next: Partial<SimState>) => {
    setSaving(true);
    updateSim(next)
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  const rain = state?.rain ?? false;
  return (
    <section className="px-4 pt-4" data-testid="simulacao">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Simulação</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          disabled={!state || saving}
          onClick={() => change({ rain: !rain })}
          aria-pressed={rain}
          data-testid="chuva"
          className={`rounded-md border px-2.5 py-1 transition-colors disabled:opacity-50 ${
            rain ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-white/10 text-zinc-300 hover:bg-white/5"
          }`}
        >
          {rain ? "Chovendo" : "Sem chuva"}
        </button>
        <div className="flex items-center rounded-md border border-white/10" role="group" aria-label="Pico de pedidos">
          <span className="px-2 text-zinc-500">Pico</span>
          {RUSH_LEVELS.map((level) => {
            const active = (state?.rush ?? 1) === level;
            return (
              <button
                key={level}
                type="button"
                disabled={!state || saving}
                onClick={() => change({ rush: level })}
                aria-pressed={active}
                data-testid={`pico-${level}`}
                className={`border-l border-white/10 px-2 py-1 tabular-nums transition-colors disabled:opacity-50 ${
                  active ? "bg-route/20 text-route" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                {level}×
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
        Chuva deixa todo trajeto 40% mais lento; pico multiplica a chegada de pedidos.
      </p>
      {error && <p className="mt-1 text-[11px] text-target">{error}</p>}
    </section>
  );
}
