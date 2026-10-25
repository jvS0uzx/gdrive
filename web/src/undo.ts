import { useCallback, useEffect, useRef, useState } from "react";

export const UNDO_MS = 5000;

interface Entry {
  label: string;
  run: () => unknown;
  timer: number;
}

// Ação destrutiva só roda depois da janela. Desmontar a tela executa o que estava
// pendente: o clique já foi confirmado pelo operador, e cancelar em silêncio perderia a ação.
export function useUndoQueue() {
  const entries = useRef(new Map<number, Entry>());
  const [pending, setPending] = useState<Record<number, string>>({});

  const forget = useCallback((id: number) => {
    setPending((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
  }, []);

  const fire = useCallback(
    (id: number) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      entries.current.delete(id);
      forget(id);
      entry.run();
    },
    [forget],
  );

  const schedule = useCallback(
    (id: number, label: string, run: () => unknown) => {
      if (entries.current.has(id)) return;
      const timer = window.setTimeout(() => fire(id), UNDO_MS);
      entries.current.set(id, { label, run, timer });
      setPending((p) => ({ ...p, [id]: label }));
    },
    [fire],
  );

  const undo = useCallback(
    (id: number) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      entries.current.delete(id);
      forget(id);
    },
    [forget],
  );

  useEffect(() => {
    const queue = entries.current;
    return () => {
      for (const id of [...queue.keys()]) fire(id);
    };
  }, [fire]);

  return { pending, schedule, undo };
}
