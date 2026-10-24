import type { ReactNode } from "react";
import Central from "./Central";
import OrderTracking from "./OrderTracking";
import RoutePlanner from "./RoutePlanner";
import { Link, usePath } from "./router";

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-2 py-1 transition-colors ${
        active ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </Link>
  );
}

function NotFound() {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <p className="text-base font-semibold text-zinc-100">Página não encontrada</p>
        <Link to="/" className="mt-2 inline-block text-sm text-route hover:underline">
          Ir para a central
        </Link>
      </div>
    </div>
  );
}

function page(path: string): ReactNode {
  if (path === "/") return <Central />;
  if (path === "/rota" || path === "/rota/") return <RoutePlanner />;
  const order = /^\/pedido\/(\d+)\/?$/.exec(path);
  if (order) return <OrderTracking key={order[1]} id={Number(order[1])} />;
  return <NotFound />;
}

export default function App() {
  const path = usePath();
  return (
    <div className="flex h-full flex-col font-sans text-zinc-200">
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-white/10 bg-panel px-4">
        <Link to="/" className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
          GDrive
        </Link>
        <nav aria-label="Telas" className="flex items-center gap-1 text-sm">
          <NavLink to="/" active={path === "/"}>
            Central
          </NavLink>
          <span className="text-zinc-600" aria-hidden="true">
            ·
          </span>
          <NavLink to="/rota" active={path.startsWith("/rota")}>
            Rota
          </NavLink>
        </nav>
      </header>
      <main className="relative min-h-0 flex-1">{page(path)}</main>
    </div>
  );
}
