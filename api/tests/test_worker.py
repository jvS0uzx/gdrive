import asyncio
import json

from app import orders
from app.db import many, one, transaction
from app.jobs import run_due, schedule
from app.outbox import relay_once
from app.seed import seed_if_empty
from app.tracking import TRACKING_STREAM, consume_once, ensure_group
from tests.conftest import online
from tests.test_pedido import create, offer_of, status_of


async def test_relay_publica_no_stream_e_marca_o_alvo(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offer = await offer_of(order)
    await client.post(f"/api/offers/{offer['id']}/accept")
    published = await relay_once(redis)
    assert published == 4
    entries = await redis.xrange("events.orders")
    assert [e[1]["type"] for e in entries] == [
        "pedido_criado",
        "pedido_aceito_pela_loja",
        "oferta_enviada",
        "entregador_atribuido",
    ]
    created = json.loads(entries[0][1]["data"])
    assert created["store"]["lat"] == -12.98 and created["store_name"] == "Acarajé da Dinha"
    assert created["store_id"] == city["stores"]["Acarajé da Dinha"]
    target = await redis.hgetall("target:1")
    assert target["order_id"] == str(order) and target["phase"] == "loja" and float(target["lat"]) == -12.98
    assert await relay_once(redis) == 0
    async with transaction() as conn:
        pending = await one(conn, "SELECT count(*) AS n FROM outbox WHERE published_at IS NULL")
    assert pending["n"] == 0

    async with transaction() as conn:
        await orders.cancel(conn, order)
    await relay_once(redis)
    assert await redis.exists("target:1") == 0


async def test_chegada_do_rastreio_muda_o_pedido(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offer = await offer_of(order)
    await client.post(f"/api/offers/{offer['id']}/accept")
    await ensure_group(redis)
    data = json.dumps({"order_id": order, "courier_id": 1, "phase": "loja"})
    for _ in range(2):
        await redis.xadd(TRACKING_STREAM, {"type": "entregador_chegou_na_loja", "data": data})
    assert await consume_once(redis, "teste", block_ms=100) == 2
    assert await status_of(order) == "na_loja"
    pending = await redis.xpending(TRACKING_STREAM, "workers")
    assert pending["pending"] == 0


async def test_job_nunca_roda_duas_vezes(city):
    executed = []

    async def handler(conn, n):
        await asyncio.sleep(0.05)
        executed.append(n)

    async with transaction() as conn:
        for n in range(9):
            await schedule(conn, "teste", n=n)
    await asyncio.gather(*(run_due({"teste": handler}, limit=3) for _ in range(4)))
    assert sorted(executed) == list(range(9))


async def test_job_que_falha_tenta_de_novo_depois(city):
    calls = []

    async def broken(conn):
        calls.append(1)
        raise RuntimeError("falhou de propósito")

    async with transaction() as conn:
        await schedule(conn, "quebrado")
    await run_due({"quebrado": broken})
    await run_due({"quebrado": broken})
    async with transaction() as conn:
        job = await one(conn, "SELECT attempts, done_at, last_error, run_at > now() AS later FROM jobs")
    assert calls == [1] and job["attempts"] == 1 and job["done_at"] is None and job["later"]
    assert "falhou de propósito" in job["last_error"]


async def test_carga_inicial_so_uma_vez(engine):
    assert await seed_if_empty(engine) is True
    assert await seed_if_empty(engine) is False
    async with transaction() as conn:
        stores = await many(conn, "SELECT name FROM stores ORDER BY id")
        couriers = await many(conn, "SELECT name, status FROM couriers ORDER BY id")
        customers = await one(conn, "SELECT count(*) AS n FROM addresses WHERE kind = 'customer'")
    assert [s["name"] for s in stores] == ["Acarajé da Dinha", "Pizzaria Longe"]
    assert couriers[0]["name"] == "Entregador 1" and couriers[0]["status"] == "offline" and len(couriers) == 4
    assert customers["n"] == 3
