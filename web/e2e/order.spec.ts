import { expect, test } from "@playwright/test";

const OPEN_LABELS =
  /^(Aguardando a loja|Em preparo|Entregador a caminho da loja|Entregador na loja)$/;

test("o cliente acompanha o pedido: loja, status e linha do tempo ao vivo", async ({ page, request }) => {
  const [store] = await (await request.get("/api/stores?limit=1")).json();
  const addresses = await (await request.get("/api/addresses?kind=customer&limit=50")).json();
  const created = await request.post("/api/orders", { data: { store_id: store.id, address_id: addresses[0].id } });
  expect(created.status()).toBe(201);
  const order = await created.json();

  await page.goto(`/pedido/${order.id}`);
  await expect(page.getByTestId("loja")).toHaveText(store.name);
  await expect(page.getByTestId("status")).toHaveText(OPEN_LABELS);
  await expect(page.getByTestId("linha-do-tempo")).toContainText("Pedido feito");
  await expect(page.getByTestId("previsao")).toHaveText(/^até \d{2}:\d{2}$/);
  await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(page.getByText("ao vivo", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "© colaboradores do OpenStreetMap" })).toBeVisible();

  expect((await request.post(`/api/orders/${order.id}/cancel`)).ok()).toBe(true);
  await expect(page.getByTestId("status")).toHaveText("Cancelado");
  await expect(page.getByTestId("linha-do-tempo")).toContainText("Pedido cancelado");
});

test("pedido que não existe mostra aviso em vez de mapa vazio", async ({ page }) => {
  await page.goto("/pedido/999999999");
  await expect(page.getByText("Pedido não encontrado")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveCount(0);
});
