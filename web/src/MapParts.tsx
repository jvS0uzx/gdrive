import type { RefObject } from "react";

export function MapSurface({ container, ready }: { container: RefObject<HTMLDivElement | null>; ready: boolean }) {
  return (
    <div className="absolute inset-0 isolate">
      <div ref={container} className="h-full w-full" data-testid="mapa" data-ready={ready ? "true" : "false"} />
    </div>
  );
}

export function LineSample({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <svg width="18" height="6" viewBox="0 0 18 6" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="3"
        x2="17"
        y2="3"
        stroke={color}
        strokeWidth={dashed ? 2 : 3}
        strokeLinecap={dashed ? "butt" : "round"}
        strokeDasharray={dashed ? "3 2" : undefined}
      />
    </svg>
  );
}

export function OsmCredit() {
  return (
    <>
      Mapa:{" "}
      <a
        className="underline decoration-faint underline-offset-2 hover:text-strong"
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © colaboradores do OpenStreetMap
      </a>
      , licença ODbL.
    </>
  );
}

export function FloatingCredit() {
  return (
    <p className="absolute bottom-0 right-0 rounded-tl-md bg-ink/80 px-2 py-1 text-[11px] leading-snug text-faint">
      <OsmCredit />
    </p>
  );
}
