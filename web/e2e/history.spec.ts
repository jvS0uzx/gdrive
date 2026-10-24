import { expect, test } from "@playwright/test";

type HistoryItem = { id: number };

test("o histórico abre o replay de uma entrega e o play avança o relógio", async ({ page, request }) => {
  test.setTimeout(60_000);
  const history: { items: HistoryItem[] } = await (await request.get("/api/history?limit=10")).json();
  let id: number | null = null;
  for (const item of history.items) {
    if ((await request.get(`/api/orders/${item.id}/track`)).ok()) {
      id = item.id;
      break;
    }
  }
  if (id === null) throw new Error("nenhuma entrega recente com trajeto gravado");

  await page.goto("/historico");
  const table = page.getByTestId("tabela-historico");
  await expect(table.getByTestId("linha-historico").first()).toBeVisible();
  await expect(page.getByTestId("paginacao")).toHaveText(/^1–\d+ de [\d.]+$/);
  await expect(table.getByTestId("linha-historico").first()).toContainText(/no prazo|atrasado/);
  await table.getByRole("link", { name: `#${id}`, exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/historico/${id}$`));
  await expect(page.getByTestId("mapa")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(page.getByTestId("loja")).not.toBeEmpty();
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
