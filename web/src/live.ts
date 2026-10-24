import { useEffect, useRef, useState } from "react";

const MAX_BACKOFF_MS = 10_000;

function socketUrl(path: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${path}`;
}

export function useSocket<T>(path: string | null, onMessage: (message: T) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);

  useEffect(() => {
    handler.current = onMessage;
  });

  useEffect(() => {
    if (!path) return;
    let socket: WebSocket | null = null;
    let timer = 0;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      socket = new WebSocket(socketUrl(path));
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (e) => handler.current(JSON.parse(e.data) as T);
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt += 1;
        timer = window.setTimeout(open, delay);
      };
    };

    open();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [path]);

  return connected;
}
