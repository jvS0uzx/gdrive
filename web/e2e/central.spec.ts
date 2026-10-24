import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";

type Snapshot = { couriers: [number, number, number, number][] };
const ACTIVE = /^(aguardando_loja|em_preparo|a_caminho_da_loja|na_loja|em_rota|no_cliente)$/;
type Courier = { id: number; lat: number; lon: number };

function socketURL(path: string): string {
  const url = new URL(path, baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function firstSnapshot(): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketURL("/ws/watch/central"));
    ws.onmessage = (e) => {
      resolve(JSON.parse(String(e.data)));
      ws.close();
    };
    ws.onerror = () => reject(new Error("a central não abriu o WebSocket"));
  });
}

function courierSocket(id: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketURL(`/ws/courier?id=${id}`));
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`o entregador ${id} não abriu o WebSocket`));
  });
}

async function counter(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? "";
  return Number(text.replace(/\D/g, ""));
}

test("a central abre o mapa de Salvador com os contadores ao vivo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  for (const id of ["entregadores-no-mapa", "entregadores-livres", "entregadores-ocupados", "pedidos-ativos"]) {
    await expect(page.getByTestId(id)).toHaveText(/^\d[\d.]*$/);
  }
  await expect(page.getByText("ao vivo", { exact: true })).toBeVisible();
  await expect(page.getByTestId("cadastro")).toHaveText(/online/);
  await expect(page.getByRole("link", { name: "© colaboradores do OpenStreetMap" })).toBeVisible();
});

test("o menu leva da central para a rota e volta", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("link", { name: "Rota" }).click();
  await expect(page).toHaveURL(/\/rota$/);
  await expect(page.getByText("Clique no mapa para marcar a origem.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation").getByRole("link", { name: "Central" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Central" })).toBeVisible();
});

test("um entregador que fica online e manda posição aparece na central", async ({ page, request }) => {
  const onMap = new Set((await firstSnapshot()).couriers.map((c) => c[0]));
  const offline: Courier[] = await (await request.get("/api/couriers?status=offline&limit=5000")).json();
  const courier = offline.find((c) => !onMap.has(c.id));
  if (!courier) throw new Error("todo entregador offline já tem posição na central");

  await page.goto("/");
  await expect(page.getByTestId("entregadores-no-mapa")).toHaveText(/^\d[\d.]*$/, { timeout: 20_000 });
  const before = await counter(page, "entregadores-no-mapa");

  const ws = await courierSocket(courier.id);
  try {
    expect((await request.post(`/api/couriers/${courier.id}/online`)).ok()).toBe(true);
    ws.send(JSON.stringify({ lat: courier.lat, lon: courier.lon }));
    await expect.poll(() => counter(page, "entregadores-no-mapa")).toBeGreaterThan(before);
  } finally {
    ws.close();
    await request.post(`/api/couriers/${courier.id}/offline`);
  }
});

test("o card #id do pedido seleciona o pedido e a análise abre o acompanhamento", async ({ page, request }) => {
  const [store] = await (await request.get("/api/stores?limit=1")).json();
  const addresses = await (await request.get("/api/addresses?kind=customer&limit=50")).json();
  const created = await request.post("/api/orders", { data: { store_id: store.id, address_id: addresses[1].id } });
  expect(created.status()).toBe(201);
  const order = await created.json();

  try {
    await page.goto("/");
    const cards = page.getByTestId("card-pedido");
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    const card = cards.filter({ hasText: `#${order.id}` });
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-status", ACTIVE);
    await expect(page.getByTestId("analise")).toHaveCount(0);

    await card.dispatchEvent("click");
    await expect(page).toHaveURL(/\/$/);
    const analysis = page.getByTestId("analise");
    await expect(analysis).toContainText(`Análise do pedido #${order.id}`);
    await expect(card).toHaveAttribute("data-selected", "true");

    await analysis.getByRole("link", { name: "Abrir acompanhamento" }).click();
    await expect(page).toHaveURL(new RegExp(`/pedido/${order.id}$`));
    await expect(page.getByTestId("loja")).toHaveText(store.name);
  } finally {
    await request.post(`/api/orders/${order.id}/cancel`);
  }
});

test("a análise de um pedido em andamento compara rotas, explica o despacho e mede o trajeto", async ({ page }) => {
  await page.goto("/");
  const moving = page.locator(
    '[data-testid="card-pedido"][data-status="em_rota"], [data-testid="card-pedido"][data-status="a_caminho_da_loja"]',
  );
  await expect(moving.first()).toBeVisible({ timeout: 20_000 });
  const card = moving.first();
  const id = ((await card.getAttribute("aria-label")) ?? "").replace(/\D/g, "");
  await card.dispatchEvent("click");

  const analysis = page.getByTestId("analise");
  await expect(analysis).toContainText(`Análise do pedido #${id}`);
  for (const row of ["alt-fastest", "alt-shortest", "alt-no_expressway"]) {
    await expect(analysis.getByTestId(row)).toContainText(/\d+ (s|min)|sem rota possível sem via expressa/);
  }
  await expect(analysis.getByTestId("alt-fastest")).toContainText(/\d+ (s|min)/);

  const dispatch = analysis.getByTestId("analise-despacho");
  await expect(dispatch.getByTestId("oferta").first()).toContainText(/raio .* km/);
  await expect(dispatch.getByTestId("candidatos").or(dispatch.getByTestId("sem-candidatos")).first()).toBeVisible();

  await expect(analysis.getByTestId("trecho-loja")).toContainText(/prevista\s*[\d,.]+ k?m\s*desvio máximo\s*\d+ m/);

  await analysis.getByRole("link", { name: "Abrir acompanhamento" }).click();
  await expect(page).toHaveURL(new RegExp(`/pedido/${id}$`));
  await expect(page.getByTestId("status")).toBeVisible();
});
