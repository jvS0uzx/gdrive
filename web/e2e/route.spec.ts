import { expect, test } from "@playwright/test";

function toSeconds(text: string): number {
  const h = /(\d+) h/.exec(text);
  const m = /(\d+) min/.exec(text);
  const s = /(\d+) s/.exec(text);
  return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
}

test("traça a rota mais rápida entre dois cliques e a chuva deixa a rota mais lenta", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Clique no mapa para marcar a origem.")).toBeVisible({ timeout: 20_000 });

  const map = page.getByTestId("mapa");
  const box = await map.boundingBox();
  if (!box) throw new Error("mapa sem dimensão");
  await map.click({ position: { x: box.width * 0.6, y: box.height * 0.6 } });
  await expect(page.getByText("Agora clique no destino.")).toBeVisible();
  await map.click({ position: { x: box.width * 0.75, y: box.height * 0.5 } });

  const tempo = page.getByTestId("tempo");
  await expect(tempo).toHaveText(/\d+ (s|min)/);
  await expect(page.getByTestId("distancia")).toHaveText(/\d.* (m|km)$/);
  await expect(page.getByTestId("vias")).toHaveText(/^Por .+/);
  const seco = toSeconds((await tempo.textContent()) ?? "");

  await page.getByTestId("chuva").check();
  await expect(page.getByText("com chuva")).toBeVisible();
  const molhado = toSeconds((await tempo.textContent()) ?? "");
  expect(molhado).toBeGreaterThan(seco);
});

test("clique fora da cidade avisa em vez de inventar rota", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Clique no mapa para marcar a origem.")).toBeVisible({ timeout: 20_000 });
  const map = page.getByTestId("mapa");
  const box = await map.boundingBox();
  if (!box) throw new Error("mapa sem dimensão");
  await map.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
  await map.click({ position: { x: box.width - 5, y: box.height - 5 } });
  await expect(page.getByText("destino: ponto fora da cidade")).toBeVisible();
});
