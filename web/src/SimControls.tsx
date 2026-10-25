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
            className="btn h-7 px-2.5 text-xs"
          >
            {fault.label}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {message && <p className={`mt-1.5 text-xs ${message.error ? "text-target" : "text-muted"}`}>{message.text}</p>}
      </div>
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
    <section className="px-4 pt-5" data-testid="simulacao">
      <h2 className="section-title">Simulação</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!state || saving}
          onClick={() => change({ rain: !rain })}
          aria-pressed={rain}
          data-testid="chuva"
          title="Chuva deixa todo trajeto 40% mais lento"
          className={`btn ${rain ? "border-deep bg-deep/25 text-strong hover:bg-deep/35" : ""}`}
        >
          Chuva
          {/* O estado fica visível em texto, não só na cor; leitor de tela já recebe pelo aria-pressed. */}
          <span aria-hidden="true" className={rain ? "text-strong" : "text-muted"}>
            {rain ? "ligada" : "desligada"}
          </span>
        </button>
        <div
          className="flex h-8 items-stretch overflow-hidden rounded-md border border-line text-[13px]"
          role="group"
          aria-label="Pico de pedidos"
          title="Multiplica a chegada de pedidos"
        >
          <span className="flex items-center bg-raised px-2.5 text-muted">Pico</span>
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
                className={`num border-l border-line px-2.5 transition-colors disabled:opacity-45 ${
                  active ? "bg-route text-ink" : "text-muted hover:bg-raised hover:text-strong"
                }`}
              >
                {level}×
              </button>
            );
          })}
        </div>
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-target" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
