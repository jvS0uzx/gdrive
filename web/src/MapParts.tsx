import type { RefObject } from "react";

export function MapSurface({ container, ready }: { container: RefObject<HTMLDivElement | null>; ready: boolean }) {
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" data-testid="mapa" data-ready={ready ? "true" : "false"} />
    </div>
  );
}

export function OsmCredit() {
  return (
    <>
      Mapa:{" "}
      <a
        className="underline decoration-zinc-600 underline-offset-2 hover:text-zinc-300"
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
    <p className="absolute bottom-2 right-2 rounded-md border border-white/10 bg-panel/90 px-2 py-1 text-[11px] leading-snug text-zinc-500 backdrop-blur">
      <OsmCredit />
    </p>
  );
}
