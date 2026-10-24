import { expect, test, type Page } from "@playwright/test";

type Store = { id: number; name: string; manual: boolean };

function card(page: Page, column: string, orderId: number) {
  return page.getByTestId(`coluna-${column}`).locator(`[data-testid="card-pedido-loja"][data-pedido="${orderId}"]`);
}

test("a loja opera na mão: o pedido de teste entra em Novos, é aceito, vai para Em preparo e fica pronto", async ({
  page,
  request,
}) => {
  const stores: Store[] = await (await request.get("/api/stores?q=pizza&limit=20")).json();
  const store = stores.find((s) => s.id !== 1 && !s.manual) ?? stores.find((s) => s.id !== 1);
  if (!store) throw new Error("nenhuma pizzaria cadastrada para o teste");
  let orderId: number | null = null;

  try {
    await page.goto("/loja");
    await page.getByRole("searchbox", { name: "Buscar loja" }).fill(store.name);
    await page.getByTestId("lista-lojas").getByRole("link", { name: store.name }).first().click();
    await expect(page).toHaveURL(new RegExp(`/loja/${store.id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(store.name);

    const manual = page.getByRole("switch", { name: /Operar na mão/ });
    await manual.check();
    await expect(manual).toBeChecked();
    await expect.poll(async () => (await (await request.get(`/api/stores/${store.id}`)).json()).manual).toBe(true);

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/stores/${store.id}/test-order`) && r.request().method() === "POST"),
      page.getByRole("button", { name: "Gerar pedido de teste" }).click(),
    ]);
    expect(response.status()).toBe(201);
    const id: number = (await response.json()).id;
    orderId = id;
    await expect(page.getByTestId("aviso-pedido-teste")).toHaveText(`Pedido #${id} criado.`);

    const fresh = card(page, "novos", id);
    await expect(fresh).toBeVisible();
    await expect(fresh).toContainText(/Cliente a \d/);
    await expect(fresh.getByTestId("recusa-automatica")).toHaveText(/^Recusa automática em [45]:\d{2}$/);
    await fresh.getByRole("combobox").selectOption("15");
    await fresh.getByRole("button", { name: "Aceitar" }).click();

    const cooking = card(page, "preparo", id);
    await expect(cooking).toBeVisible();
    await expect(cooking).toContainText("Preparo de 15 min");
    await expect(cooking.getByTestId("situacao-entregador")).toHaveText(/Procurando entregador|a caminho|na loja/);
    await expect(card(page, "novos", id)).toHaveCount(0);
    await cooking.getByRole("button", { name: "Marcar pronto" }).click();

    await expect(card(page, "prontos", id)).toContainText(/Pronto (agora|há \d+ min)/);
    const order = await (await request.get(`/api/orders/${id}`)).json();
    expect(order.prep_minutes).toBe(15);
    expect(order.ready_at).not.toBeNull();

    await manual.uncheck();
    await expect(manual).not.toBeChecked();
    await expect.poll(async () => (await (await request.get(`/api/stores/${store.id}`)).json()).manual).toBe(false);
  } finally {
    if (orderId !== null) await request.post(`/api/orders/${orderId}/cancel`);
    await request.put(`/api/stores/${store.id}/manual`, { data: { manual: false } });
  }
});

test("loja que não existe mostra aviso e caminho de volta", async ({ page }) => {
  await page.goto("/loja/999999999");
  await expect(page.getByText("Loja não encontrada")).toBeVisible();
  await expect(page.getByRole("link", { name: "Escolher outra loja" })).toHaveAttribute("href", "/loja");
});

test("o painel da loja empilha as colunas no celular", async ({ page, request }) => {
  const [store]: Store[] = await (await request.get("/api/stores?q=bar&limit=1")).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/loja/${store.id}`);
  await expect(page.getByTestId("coluna-novos")).toBeVisible();
  const novos = await page.getByTestId("coluna-novos").boundingBox();
  const preparo = await page.getByTestId("coluna-preparo").boundingBox();
  if (!novos || !preparo) throw new Error("colunas sem dimensão");
  expect(preparo.y).toBeGreaterThan(novos.y + novos.height - 1);
  expect(Math.abs(preparo.x - novos.x)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
