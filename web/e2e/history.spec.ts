import { expect, test, type APIRequestContext } from "@playwright/test";

type HistoryItem = { id: number };

async function trackedDelivery(request: APIRequestContext): Promise<number> {
  const history: { items: HistoryItem[] } = await (await request.get("/api/history?limit=10")).json();
  for (const item of history.items) {
    if ((await request.get(`/api/orders/${item.id}/track`)).ok()) return item.id;
  }
  throw new Error("nenhuma entrega recente com trajeto gravado");
}

test("o histórico abre o replay de uma entrega e o play avança o relógio", async ({ page, request }) => {
  test.setTimeout(60_000);
  const id = await trackedDelivery(request);

  await page.goto("/historico");
  const table = page.getByTestId("tabela-historico");
  await expect(table.getByTestId("linha-historico").first()).toBeVisible();
  await expect(page.getByTestId("paginacao")).toHaveText(/^1–\d+ de [\d.]+$/);
  await expect(table.getByTestId("linha-historico").first()).toContainText(/no prazo|atrasado/);
  await table.getByRole("link", { name: `#${id}`, exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/historico/${id}$`));
  await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(page.getByTestId("loja")).not.toBeEmpty();
  const map = await page.getByTestId("mapa").boundingBox();
  const title = await page.getByTestId("loja").boundingBox();
  if (!map || !title) throw new Error("replay sem dimensão");
  expect(map.x).toBeGreaterThanOrEqual(title.x + title.width);
  await expect(page.getByTestId("trecho-cliente")).toContainText(/Andou\s*[\d,]+ k?m de [\d,]+ k?m previstos/);
  await expect(page.getByTestId("trecho-cliente")).toContainText(/Desvio máximo\s*\d+ m/);

  const slider = page.getByTestId("replay-slider");
  await expect(slider).toHaveValue("0");
  await page.getByRole("button", { name: "1×" }).click();
  await expect(page.getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "true");
  const play = page.getByTestId("replay-play");
  await play.click();
  await expect(play).toHaveAccessibleName("Pausar");
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);

  await play.click();
  await expect(play).toHaveAccessibleName("Reproduzir");
  const paused = await slider.inputValue();
  await page.waitForTimeout(400);
  expect(await slider.inputValue()).toBe(paused);

  const max = await slider.getAttribute("max");
  await slider.fill(max ?? "0");
  await expect(slider).toHaveValue(max ?? "0");
  const events = page.getByTestId("replay-linha-do-tempo").locator("button");
  await expect(events.last()).toHaveAttribute("data-passou", "true");
  await expect(events.first()).toHaveAttribute("data-passou", "true");
  await expect(page.getByTestId("replay-linha-do-tempo")).toContainText("Pedido entregue");
});

test("no celular o histórico cabe sem rolagem lateral e o replay põe o mapa acima do painel", async ({
  page,
  request,
}) => {
  const id = await trackedDelivery(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/historico");
  await expect(page.getByTestId("linha-historico").first()).toContainText(/no prazo|atrasado/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.goto(`/historico/${id}`);
  await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const map = await page.getByTestId("mapa").boundingBox();
  const title = await page.getByTestId("loja").boundingBox();
  if (!map || !title) throw new Error("replay sem dimensão");
  expect(map.width).toBeGreaterThan(380);
  expect(title.y).toBeGreaterThan(map.y + map.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("entrega sem trajeto gravado mostra aviso em vez de mapa vazio", async ({ page }) => {
  await page.goto("/historico/999999999");
  await expect(page.getByTestId("sem-trajeto")).toHaveText("Trajeto ainda não gravado");
  await expect(page.getByTestId("replay-play")).toHaveCount(0);
});

test("o menu leva para loja, entregador e histórico", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation");
  for (const [name, path, text] of [
    ["Loja", "/loja", "Qual loja você vai operar?"],
    ["Entregador", "/entregador", "Pilote um entregador pelo celular"],
    ["Histórico", "/historico", "Entregas feitas"],
  ]) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text);
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  }
});

test("a página do histórico fica na URL: avança, volta e abre direto pelo link", async ({ page }) => {
  await page.goto("/historico");
  const range = page.getByTestId("paginacao");
  await expect(range).toHaveText(/^1–50 de [\d.]+$/);

  await page.getByRole("button", { name: "Mais antigas" }).click();
  await expect(page).toHaveURL(/\/historico\?pagina=2$/);
  await expect(range).toHaveText(/^51–100 de /);

  await page.getByRole("button", { name: "Mais recentes" }).click();
  await expect(page).toHaveURL(/\/historico$/);
  await expect(range).toHaveText(/^1–50 de /);

  await page.goBack();
  await expect(range).toHaveText(/^51–100 de /);

  await page.goto("/historico?pagina=3");
  await expect(range).toHaveText(/^101–150 de /);
});
