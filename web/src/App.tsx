import { Fragment, type ReactNode } from "react";
import Central from "./Central";
import CourierApp from "./CourierApp";
import CourierPicker from "./CourierPicker";
import History from "./History";
import OrderTracking from "./OrderTracking";
import Replay from "./Replay";
import RoutePlanner from "./RoutePlanner";
import { Link, usePath } from "./router";
import StorePanel from "./StorePanel";
import StorePicker from "./StorePicker";

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 rounded-md px-1.5 py-1 transition-colors sm:px-2 ${
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

const within = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

const SECTIONS = [
  { to: "/", label: "Central", active: (path: string) => path === "/" },
  { to: "/rota", label: "Rota", active: (path: string) => within(path, "/rota") },
  { to: "/loja", label: "Loja", active: (path: string) => within(path, "/loja") },
  { to: "/entregador", label: "Entregador", active: (path: string) => within(path, "/entregador") },
  { to: "/historico", label: "Histórico", active: (path: string) => within(path, "/historico") },
];

function page(path: string): ReactNode {
  if (path === "/") return <Central />;
  if (path === "/rota" || path === "/rota/") return <RoutePlanner />;
  if (path === "/loja" || path === "/loja/") return <StorePicker />;
  if (path === "/entregador" || path === "/entregador/") return <CourierPicker />;
  if (path === "/historico" || path === "/historico/") return <History />;
  const order = /^\/pedido\/(\d+)\/?$/.exec(path);
  if (order) return <OrderTracking key={order[1]} id={Number(order[1])} />;
  const store = /^\/loja\/(\d+)\/?$/.exec(path);
  if (store) return <StorePanel key={store[1]} id={Number(store[1])} />;
  const courier = /^\/entregador\/(\d+)\/?$/.exec(path);
  if (courier) return <CourierApp key={courier[1]} id={Number(courier[1])} />;
  const replay = /^\/historico\/(\d+)\/?$/.exec(path);
  if (replay) return <Replay key={replay[1]} id={Number(replay[1])} />;
  return <NotFound />;
}

export default function App() {
  const path = usePath();
  return (
    <div className="flex h-full flex-col font-sans text-zinc-200">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 bg-panel px-3 sm:gap-4 sm:px-4">
        <Link
          to="/"
          className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300 sm:block"
        >
          GDrive
        </Link>
        <nav aria-label="Telas" className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm">
          {SECTIONS.map((section, i) => (
            <Fragment key={section.to}>
              {i > 0 && (
                <span className="hidden text-zinc-600 sm:inline" aria-hidden="true">
                  ·
                </span>
              )}
              <NavLink to={section.to} active={section.active(path)}>
                {section.label}
              </NavLink>
            </Fragment>
          ))}
        </nav>
      </header>
      <main className="relative min-h-0 flex-1">{page(path)}</main>
    </div>
  );
}
