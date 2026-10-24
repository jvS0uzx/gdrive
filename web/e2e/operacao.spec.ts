import { expect, test, type APIRequestContext } from "@playwright/test";

type Listed = { id: number; courier_id: number | null };
type Courier = { id: number; human: boolean };

const UNASSIGNABLE = ["a_caminho_da_loja", "na_loja"];

async function statusOf(request: APIRequestContext, id: number): Promise<string> {
  return (await (await request.get(`/api/orders/${id}`)).json()).status;
}

async function silenceSomeone(request: APIRequestContext): Promise<{ order: number; courier: number }> {
  const simulated = new Set(
    ((await (await request.get("/api/couriers?human=false&limit=500")).json()) as Courier[]).map((c) => c.id),
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const listed: Listed[] = await (await request.get("/api/orders?status=a_caminho_da_loja&limit=20")).json();
    for (const o of listed) {
      if (o.courier_id === null || !simulated.has(o.courier_id)) continue;
      const sent = await request.post(`/api/sim/couriers/${o.courier_id}/sem_sinal`, { data: { seconds: 120 } });
      expect(sent.status()).toBe(202);
      await new Promise((r) => setTimeout(r, 2000));
      if (UNASSIGNABLE.includes(await statusOf(request, o.id))) return { order: o.id, courier: o.courier_id };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("nenhum pedido a caminho da loja ficou parado para o teste");
}

test("chuva e pico mudam pelo painel da central", async ({ page, request }) => {
  try {
    await page.goto("/");
    const panel = page.getByTestId("simulacao");
    const rain = panel.getByTestId("chuva");
    await expect(rain).toBeEnabled({ timeout: 20_000 });
    await expect(rain).toHaveText("Sem chuva");
    await rain.click();
    await expect(rain).toHaveText("Chovendo");
    await expect.poll(async () => (await (await request.get("/api/sim")).json()).rain).toBe(true);

    await panel.getByTestId("pico-3").click();
    await expect(panel.getByTestId("pico-3")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await (await request.get("/api/sim")).json()).rush).toBe(3);
  } finally {
    await request.put("/api/sim", { data: { rain: false, rush: 1 } });
  }
});

test("entregador sem sinal vira alerta na central e a central libera o pedido", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { order, courier } = await silenceSomeone(request);

  await page.goto("/");
  const card = page.getByTestId("card-pedido").filter({ hasText: `#${order}` });
  await expect(card).toHaveAttribute("data-alerts", /sinal_perdido/, { timeout: 45_000 });
  await expect(page.getByTestId("lista-alertas")).toContainText(`#${order}`);

  await card.dispatchEvent("click");
  const operation = page.getByTestId("analise-operacao");
  await expect(operation.getByTestId("alertas-do-pedido")).toContainText("Sem sinal");
  await operation.getByTestId("desatribuir").click();
  await expect(page.getByTestId("operacao-resultado")).toContainText(`#${courier} liberado`);

  await expect(card).not.toHaveAttribute("data-alerts", /sinal_perdido/, { timeout: 10_000 });
  const detail = await (await request.get(`/api/orders/${order}`)).json();
  expect(detail.timeline.map((e: { type: string }) => e.type)).toContain("entregador_desatribuido");
  expect(detail.courier?.id ?? null).not.toBe(courier);
});
