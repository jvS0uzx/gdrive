import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";

type LngLat = [number, number];
type Courier = { id: number; name: string; status: string; human: boolean; lat: number; lon: number };
type Store = { id: number; name: string; lat: number; lon: number };
type Snapshot = { couriers: [number, number, number, number][] };

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

function metersBetween(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function offlinePool(request: APIRequestContext): Promise<Courier[]> {
  const pool: Courier[] = await (await request.get("/api/couriers?status=offline&limit=12")).json();
  if (pool.length === 0) throw new Error("nenhum entregador offline para o teste");
  return pool;
}

async function takeOrder(page: Page, request: APIRequestContext, courierId: number, orderId: number): Promise<string> {
  const view = await (await request.get(`/api/couriers/${courierId}`)).json();
  if (view.order?.id === orderId) return "nosso";
  if (view.order) throw new Error(`o entregador está com outro pedido, o #${view.order.id}`);
  if (view.offer) {
    const ours = view.offer.order_id === orderId;
    await page
      .getByTestId("oferta")
      .getByRole("button", { name: ours ? "Aceitar" : "Recusar" })
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    return ours ? "aceitando" : "recusando";
  }
  const order = await (await request.get(`/api/orders/${orderId}`)).json();
  if (order.courier && order.courier.id !== courierId) await request.post(`/api/orders/${orderId}/unassign`);
  const assigned = await request.post(`/api/orders/${orderId}/assign`, { data: { courier_id: courierId } });
  return assigned.ok() ? "nosso" : "tentando";
}

test("o entregador escolhido fica online, manda posição e volta a ficar offline", async ({ page, request }) => {
  const pool = await offlinePool(request);
  const courier = pool[pool.length - 1];

  try {
    await page.goto("/entregador");
    await page.locator(`a[href="/entregador/${courier.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/entregador/${courier.id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(courier.name);
    await expect(page.getByTestId("situacao")).toHaveText("Offline");

    await page.getByRole("button", { name: "Ficar online" }).click();
    await expect(page.getByTestId("situacao")).toHaveText("Livre");
    await expect(page.getByTestId("conexao")).toHaveText("GPS ao vivo");
    await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
    await expect(page.getByRole("switch", { name: /Piloto automático/ })).toBeChecked();
    await expect.poll(async () => (await firstSnapshot()).couriers.some((c) => c[0] === courier.id)).toBe(true);
    expect((await (await request.get(`/api/couriers/${courier.id}`)).json()).human).toBe(true);

    await page.getByRole("button", { name: "Ficar offline" }).click();
    await expect(page.getByTestId("situacao")).toHaveText("Offline");
    await expect(page.getByTestId("conexao")).toHaveText("sem GPS");
  } finally {
    await request.post(`/api/couriers/${courier.id}/offline`);
  }
});

test("entregador do simulador não pode ser pilotado pelo celular", async ({ page, request }) => {
  const online: Courier[] = await (await request.get("/api/couriers?human=false&limit=200")).json();
  const simulated = online.find((c) => c.status !== "offline");
  if (!simulated) throw new Error("nenhum entregador do simulador online");
  await page.goto(`/entregador/${simulated.id}`);
  await expect(page.getByTestId("do-simulador")).toContainText("Este entregador é do simulador.", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Ficar online" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Escolher outro entregador" })).toHaveAttribute("href", "/entregador");
});

test("a tela do entregador cabe no celular sem rolagem lateral", async ({ page, request }) => {
  const pool = await offlinePool(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/entregador/${pool[0].id}`);
  await expect(page.getByRole("button", { name: "Ficar online" })).toBeVisible();
  await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const map = await page.getByTestId("mapa").boundingBox();
  expect(map?.width).toBeGreaterThan(380);
});

test("corrida completa pelo celular: vai à loja, retira quando fica pronto e entrega", async ({ page, request }) => {
  test.setTimeout(180_000);
  const pool = await offlinePool(request);
  const courier = pool[pool.length - 1];
  const home: LngLat = [courier.lon, courier.lat];
  const stores: Store[] = await (await request.get("/api/stores?limit=5000")).json();
  const store = stores
    .filter((s) => s.id !== 1)
    .map((s) => ({ s, d: metersBetween(home, [s.lon, s.lat]) }))
    .filter((x) => x.d >= 600 && x.d <= 2500)
    .sort((a, b) => a.d - b.d)[0]?.s;
  if (!store) throw new Error("nenhuma loja entre 600 m e 2,5 km da casa do entregador");
  let orderId: number | null = null;

  try {
    await page.goto(`/entregador/${courier.id}?velocidade=30`);
    await page.getByRole("button", { name: "Ficar online" }).click();
    await expect(page.getByTestId("conexao")).toHaveText("GPS ao vivo");
    await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
    await expect(page.getByRole("switch", { name: /Piloto automático/ })).toBeChecked();
    await expect(page.getByText("Segue a rota a 30× a velocidade da via.")).toBeVisible();

    expect((await request.put(`/api/stores/${store.id}/manual`, { data: { manual: true } })).ok()).toBe(true);
    const created = await request.post(`/api/stores/${store.id}/test-order`);
    expect(created.status()).toBe(201);
    const id: number = (await created.json()).id;
    orderId = id;
    const accepted = await request.post(`/api/stores/${store.id}/orders/${id}/accept`, { data: { prep_minutes: 10 } });
    expect(accepted.ok()).toBe(true);

    await expect
      .poll(() => takeOrder(page, request, courier.id, id), { timeout: 60_000, intervals: [1_000] })
      .toBe("nosso");

    const ride = page.getByTestId("corrida");
    await expect(ride).toHaveAttribute("data-pedido", String(id));
    await expect(ride.getByTestId("corrida-status")).toHaveText(/Indo para a loja|Na loja/);
    await expect(ride).toContainText(store.name);
    await expect(page.getByRole("button", { name: "Ficar offline" })).toHaveCount(0);
    await expect(ride.getByTestId("corrida-status")).toHaveText("Na loja", { timeout: 60_000 });

    await expect(ride.getByTestId("ainda-nao-pronto")).toBeVisible();
    await ride.getByRole("button", { name: "Confirmar retirada" }).click();
    await expect(page.getByTestId("erro-acao")).toHaveText("pedido ainda não está pronto");

    expect((await request.post(`/api/stores/${store.id}/orders/${id}/ready`)).ok()).toBe(true);
    await expect(ride.getByTestId("ainda-nao-pronto")).toHaveCount(0);
    await ride.getByRole("button", { name: "Confirmar retirada" }).click();
    await expect(ride.getByTestId("corrida-status")).toHaveText(/Levando ao cliente|No endereço do cliente/);
    await expect(ride.getByTestId("corrida-status")).toHaveText("No endereço do cliente", { timeout: 60_000 });

    await ride.getByRole("button", { name: "Confirmar entrega" }).click();
    await expect.poll(async () => (await (await request.get(`/api/orders/${id}`)).json()).status).toBe("entregue");
    const done = await (await request.get(`/api/orders/${id}`)).json();
    expect(done.courier.id).toBe(courier.id);
    expect(done.timeline.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["entregador_chegou_na_loja", "pedido_coletado", "entregador_chegou_no_cliente", "pedido_entregue"]),
    );
    await expect(page.getByTestId("situacao")).toHaveText("Livre");

    await page.getByRole("button", { name: "Ficar offline" }).click();
    await expect(page.getByTestId("situacao")).toHaveText("Offline");
  } finally {
    await request.put(`/api/stores/${store.id}/manual`, { data: { manual: false } });
    if (orderId !== null) await request.post(`/api/orders/${orderId}/cancel`);
    await request.post(`/api/couriers/${courier.id}/offline`);
  }
});
