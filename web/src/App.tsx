import type { ReactNode } from "react";
import Central from "./Central";
import CourierApp from "./CourierApp";
import CourierPicker from "./CourierPicker";
import History from "./History";
import OrderTracking from "./OrderTracking";
import Replay from "./Replay";
import RoutePlanner from "./RoutePlanner";
import { BrandSymbol } from "./Brand";
import { Link, usePath } from "./router";
import StorePanel from "./StorePanel";
import StorePicker from "./StorePicker";

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-full shrink-0 items-center px-2.5 text-[13px] font-medium transition-colors after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full ${
        active ? "text-strong after:bg-route" : "text-muted hover:text-strong after:bg-transparent"
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
        <p className="text-base font-semibold text-strong">Página não encontrada</p>
        <Link to="/" className="link mt-2 inline-block text-sm">
          Voltar para a central
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
    <div className="flex h-full flex-col font-sans text-strong">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:text-sm focus:text-strong"
      >
        Ir para o conteúdo
      </a>
      <header className="flex h-12 shrink-0 items-stretch gap-2 border-b border-line bg-panel pl-3 pr-2 sm:gap-6 sm:px-4">
        <Link to="/" className="flex shrink-0 items-center gap-1.5" aria-label="Gdrive, ir para a central">
          <BrandSymbol className="size-8 shrink-0" />
          <span className="hidden font-brand text-[19px] font-extrabold leading-none tracking-[-0.02em] text-white sm:inline">
            Gdrive
          </span>
        </Link>
        <nav aria-label="Telas" className="flex min-w-0 items-stretch overflow-x-auto">
          {SECTIONS.map((section) => (
            <NavLink key={section.to} to={section.to} active={section.active(path)}>
              {section.label}
            </NavLink>
          ))}
        </nav>
        <p className="ml-auto hidden shrink-0 items-center text-xs text-faint lg:flex">Salvador, BA</p>
      </header>
      <main id="conteudo" tabIndex={-1} className="relative min-h-0 flex-1">
        {page(path)}
      </main>
    </div>
  );
}
