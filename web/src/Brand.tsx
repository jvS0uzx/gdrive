import { useId } from "react";

const PIN = "M44 62C38 52 24 41 24 26A20 20 0 1 1 64 26C64 41.6 50.8 51.6 44 62Z";
const G = "M50.75 20.2A9.34 9.34 0 1 0 52.92 26.85L44.8 26.85";
const TRAILS = [
  "M14.8 15.6Q20.6 13.77 26.4 13.5A1.7 1.7 0 0 1 26.4 16.9Q20.6 16.63 14.8 15.6Z",
  "M7.6 23.2Q15.7 21.18 23.8 20.8A2.4 2.4 0 0 1 23.8 25.6Q15.7 25.22 7.6 23.2Z",
  "M13.2 30.9Q18.8 29.6 24.4 29.3A1.9 1.9 0 0 1 24.4 33.1Q18.8 32.8 13.2 30.9Z",
];

export const BRAND = { navy: "#0A1B2A", cyan: "#00ADD8", deepCyan: "#0B7FA3", mist: "#EEF2F5" };

const TRAIL_COLORS = {
  dark: [BRAND.deepCyan, BRAND.cyan, BRAND.deepCyan],
  light: ["#9AA0A6", BRAND.navy, "#5C6670"],
};

export function BrandSymbol({ variant = "dark", className }: { variant?: "dark" | "light"; className?: string }) {
  const mask = useId();
  return (
    <svg viewBox="6 4 60 60" className={className} aria-hidden="true">
      <mask id={mask} maskUnits="userSpaceOnUse" x="-20" y="-20" width="120" height="120">
        <rect x="-20" y="-20" width="120" height="120" fill="#fff" />
        <path
          d={G}
          fill="none"
          stroke="#000"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform="rotate(10 44 26)"
        />
      </mask>
      {TRAILS.map((d, i) => (
        <path key={d} d={d} fill={TRAIL_COLORS[variant][i]} />
      ))}
      <g mask={`url(#${mask})`}>
        <path d={PIN} fill={BRAND.cyan} transform="rotate(13 44 26)" />
      </g>
    </svg>
  );
}
