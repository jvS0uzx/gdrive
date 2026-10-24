import { useEffect, useRef, useState } from "react";
import { Map as MapLibre, setWorkerUrl, type PaddingOptions } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Feature, FeatureCollection, LineString, Point as GeoPoint } from "geojson";
import { fetchMeta, type CityMeta, type LngLat } from "./api";

setWorkerUrl(workerUrl);

export const COLORS = {
  ink: "#0a1b2a",
  arrow: "#8ea3b5",
  route: "#00add8",
  origin: "#4cc38a",
  target: "#ec6a5e",
  free: "#a9bccb",
  busy: "#00add8",
  store: "#a993e6",
  customer: "#4cc38a",
  shortest: "#eef2f5",
  noExpressway: "#e3c45c",
  storeDot: "#7890a4",
  customerDot: "#a9bccb",
  highlight: "#eef2f5",
};

export const ROADS = [
  { id: "travessa", label: "Travessa", color: "#122a40", width: [0.3, 0.9, 3] },
  { id: "rua", label: "Rua", color: "#18324c", width: [0.4, 1.2, 4] },
  { id: "coletora", label: "Coletora", color: "#23425f", width: [0.7, 1.8, 5.5] },
  { id: "avenida", label: "Avenida", color: "#335978", width: [1.1, 2.6, 8] },
  { id: "expressa", label: "Via expressa", color: "#5d809f", width: [1.6, 3.4, 10] },
] as const;

export const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function byZoom(z11: number, z14: number, z17: number): number {
  return ["interpolate", ["linear"], ["zoom"], 11, z11, 14, z14, 17, z17] as unknown as number;
}

export function point(at: LngLat, properties: Record<string, unknown> = {}): Feature<GeoPoint> {
  return { type: "Feature", geometry: { type: "Point", coordinates: at }, properties };
}

export function line(coordinates: LngLat[], properties: Record<string, unknown> = {}): Feature<LineString> {
  return { type: "Feature", geometry: { type: "LineString", coordinates }, properties };
}

export function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

export function metersBetween(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function panelPadding(margin = 32): PaddingOptions | number {
  return margin;
}

export function pin(content: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "grid size-7 place-items-center rounded-full text-xs font-bold text-ink shadow-lg ring-2 ring-ink";
  el.style.background = color;
  el.innerHTML = content;
  return el;
}

function arrowImage(): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = COLORS.arrow;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(11, 8);
  ctx.lineTo(21, 16);
  ctx.lineTo(11, 24);
  ctx.stroke();
  return ctx.getImageData(0, 0, 32, 32);
}

function addStreets(map: MapLibre, meta: CityMeta) {
  map.addSource("ruas", {
    type: "vector",
    tiles: [new URL(meta.tiles.url, window.location.origin).href.replaceAll("%7B", "{").replaceAll("%7D", "}")],
    minzoom: meta.tiles.minzoom,
    maxzoom: meta.tiles.maxzoom,
    bounds: meta.bbox,
  });
  for (const road of ROADS) {
    map.addLayer({
      id: road.id,
      type: "line",
      source: "ruas",
      "source-layer": meta.tiles.layer,
      filter: ["==", ["get", "class"], road.id],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": road.color, "line-width": byZoom(road.width[0], road.width[1], road.width[2]) },
    });
  }
  map.addImage("mao-unica", arrowImage(), { pixelRatio: 2 });
  map.addLayer({
    id: "mao-unica",
    type: "symbol",
    source: "ruas",
    "source-layer": meta.tiles.layer,
    minzoom: 15.2,
    filter: ["==", ["get", "oneway"], true],
    layout: {
      "symbol-placement": "line-center",
      "icon-image": "mao-unica",
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-size": 0.85,
    },
  });
}

export function useCityMap(setup: (map: MapLibre) => void) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [meta, setMeta] = useState<CityMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let instance: MapLibre | undefined;
    let observer: ResizeObserver | undefined;
    fetchMeta()
      .then((m) => {
        if (cancelled || !container.current) return;
        setMeta(m);
        const created = new MapLibre({
          container: container.current,
          style: {
            version: 8,
            sources: {},
            layers: [{ id: "fundo", type: "background", paint: { "background-color": COLORS.ink } }],
          },
          bounds: m.bbox,
          fitBoundsOptions: { padding: 24 },
          attributionControl: false,
          dragRotate: false,
          maxZoom: 18,
        });
        instance = created;
        map.current = created;
        observer = new ResizeObserver(() => created.resize());
        observer.observe(container.current);
        created.on("load", () => {
          addStreets(created, m);
          setup(created);
        });
        created.on("sourcedata", (e) => {
          if (e.sourceId === "ruas" && e.isSourceLoaded) setReady(true);
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`A cidade não carregou: ${err.message}`);
      });
    return () => {
      cancelled = true;
      observer?.disconnect();
      instance?.remove();
      map.current = null;
    };
  }, []);

  return { container, map, meta, ready, error };
}
