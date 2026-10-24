import json
import time

from app import orders
from app.db import many, one, run, transaction
from app.monitor import watch_signal
from app.outbox import relay_once
from app.tracking import TRACKING_STREAM, consume_once, ensure_group
from tests.conftest import online, outbox_types
from tests.test_pedido import arrive, create, offer_of, status_of


async def assigned(client, city, jobs, courier=1):
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offer = await offer_of(order)
    assert offer["courier_id"] == courier
    assert (await client.post(f"/api/offers/{offer['id']}/accept")).status_code == 200
    return order


async def open_alerts(order_id):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT kind FROM alerts WHERE order_id = :id AND closed_at IS NULL ORDER BY id",
            id=order_id,
        )
    return [row["kind"] for row in rows]


async def timeline_types(order_id):
    async with transaction() as conn:
        rows = await many(conn, "SELECT type FROM order_events WHERE order_id = :id ORDER BY id", id=order_id)
    return [row["type"] for row in rows]


async def test_central_desatribui_e_o_despacho_oferece_a_outro(client, city, redis, jobs):
    await online(redis, client, 1, 2)
    order = await assigned(client, city, jobs)
    await relay_once(redis)
    await redis.hset(f"plan:{order}", mapping={"loja": "{}", "cliente": "{}"})
    await redis.rpush(f"track:{order}:loja", "1,2,3")
    assert await redis.exists("target:1") == 1

    response = await client.post(f"/api/orders/{order}/unassign")
    assert response.status_code == 200 and response.json()["courier_id"] == 1
    assert await status_of(order) == "em_preparo"
    couriers = {c["id"]: c["status"] for c in (await client.get("/api/couriers")).json()}
    assert couriers[1] == "livre"
    await relay_once(redis)
    assert await redis.exists("target:1") == 0
    assert await redis.hkeys(f"plan:{order}") == ["cliente"]
    assert await redis.exists(f"track:{order}:loja") == 0

    await jobs()
    offer = await offer_of(order)
    assert offer["courier_id"] == 2 and offer["status"] == "pendente"
    kinds, payloads = await outbox_types(order)
    unassigned = payloads[kinds.index("entregador_desatribuido")]
    assert unassigned["courier_id"] == 1 and unassigned["status"] == "em_preparo"
    assert (await client.post(f"/api/orders/{order}/unassign")).status_code == 409


async def test_central_atribui_na_mao_e_fecha_o_alerta_sem_entregador(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offer = await offer_of(order)
    async with transaction() as conn:
        from app.alerts import open_alert

        await open_alert(conn, order, "sem_entregador", "despacho", radius_m=6000)
    assert await open_alerts(order) == ["sem_entregador"]

    await online(redis, client, 2)
    candidates = (await client.get(f"/api/orders/{order}/candidates")).json()
    assert [c["courier_id"] for c in candidates] == [2]
    assert (await client.post(f"/api/orders/{order}/assign", json={"courier_id": 1})).status_code == 409

    response = await client.post(f"/api/orders/{order}/assign", json={"courier_id": 2})
    assert response.status_code == 200, response.text
    assert await status_of(order) == "a_caminho_da_loja"
    assert (await offer_of(order))["status"] == "expirada" and offer["courier_id"] == 1
    assert await open_alerts(order) == []
    kinds, payloads = await outbox_types(order)
    assert kinds[-2:] == ["entregador_atribuido", "alerta_resolvido"]
    assert payloads[-2]["courier_id"] == 2 and payloads[-2]["store"]["lat"] == -12.98
    assert payloads[-1]["alert"] == "sem_entregador"
    assert (await client.post(f"/api/orders/{order}/assign", json={"courier_id": 2})).status_code == 409


async def test_sinal_perdido_abre_e_volta_fecha(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await assigned(client, city, jobs)
    assert await watch_signal(redis) == 0

    await redis.hset("courier:1", "ts", int(time.time() * 1000) - 60_000)
    assert await watch_signal(redis) == 1
    assert await watch_signal(redis) == 0
    assert await open_alerts(order) == ["sinal_perdido"]
    kinds, payloads = await outbox_types(order)
    lost = payloads[kinds.index("sinal_perdido")]
    assert lost["alert"] == "sinal_perdido" and lost["silent_seconds"] >= 60 and lost["alert_at"] > 0

    await redis.hset("courier:1", "ts", int(time.time() * 1000))
    assert await watch_signal(redis) == 1
    assert await open_alerts(order) == []
    kinds, payloads = await outbox_types(order)
    assert kinds[-1] == "alerta_resolvido" and payloads[-1]["alert"] == "sinal_perdido"
    assert "sinal_perdido" not in await timeline_types(order)


async def test_despacho_ignora_entregador_sem_sinal(client, city, redis, jobs, engine):
    await online(redis, client, 1, 2)
    await redis.hset("courier:1", "ts", int(time.time() * 1000) - 60_000)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    assert (await offer_of(order))["courier_id"] == 2
    assert 1 not in sum(engine.eta_calls, [])


async def test_parado_e_desvio_vem_do_rastreio(client, city, redis, jobs):
    await online(redis, client, 1, 2)
    order = await assigned(client, city, jobs)
    await ensure_group(redis)

    async def send(kind, courier=1, **extra):
        data = json.dumps({"order_id": order, "courier_id": courier, "phase": "loja", **extra})
        await redis.xadd(TRACKING_STREAM, {"type": kind, "data": data})
        await consume_once(redis, "teste", block_ms=100)

    await send("entregador_parado", courier=2, seconds=40)
    assert await open_alerts(order) == []
    await send("entregador_parado", seconds=40)
    await send("desvio_de_rota", meters=310)
    await send("desvio_de_rota", meters=420)
    assert await open_alerts(order) == ["parado", "desvio"]
    async with transaction() as conn:
        detail = await one(
            conn, "SELECT detail FROM alerts WHERE kind = 'desvio' AND order_id = :id", id=order
        )
    assert detail["detail"] == {"meters": 310}

    await send("entregador_em_movimento")
    assert await open_alerts(order) == ["desvio"]
    await arrive(order, "loja")
    assert await open_alerts(order) == []
    kinds, payloads = await outbox_types(order)
    assert [p["alert"] for p in payloads if p["type"] == "alerta_resolvido"] == ["parado", "desvio"]


async def test_atraso_abre_no_prazo_e_entrega_fecha_tudo(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await assigned(client, city, jobs)
    async with transaction() as conn:
        due = await one(conn, "SELECT count(*) AS n FROM jobs WHERE kind = 'late_check' AND done_at IS NULL")
    assert due["n"] == 1
    await jobs(force=True)
    assert await open_alerts(order) == ["atraso"]
    assert "pedido_atrasado" in await timeline_types(order)
    async with transaction() as conn:
        await orders.arrived(conn, order, "loja")
        await run(conn, "UPDATE orders SET ready_at = now() WHERE id = :id", id=order)
    await client.post(f"/api/orders/{order}/pickup", json={"courier_id": 1})
    await arrive(order, "cliente")
    await client.post(f"/api/orders/{order}/deliver", json={"courier_id": 1})
    assert await open_alerts(order) == []
    async with transaction() as conn:
        row = await one(conn, "SELECT delivered_at FROM orders WHERE id = :id", id=order)
    assert row["delivered_at"] is not None

    listed = (await client.get("/api/alerts?open=false")).json()
    assert [(a["order_id"], a["kind"]) for a in listed] == [(order, "atraso")]
    assert listed[0]["closed_at"] is not None and listed[0]["store_name"] == "Acarajé da Dinha"
    assert (await client.get("/api/alerts")).json() == []


async def test_controles_da_simulacao(client, city, redis):
    assert (await client.get("/api/sim")).json() == {"rain": False, "rush": 1.0}
    response = await client.put("/api/sim", json={"rain": True, "rush": 3})
    assert response.json() == {"rain": True, "rush": 3.0}
    assert await redis.hget("city:weather", "rain") == "1"
    assert (await client.put("/api/sim", json={"rush": 11})).status_code == 422
    assert (await client.put("/api/sim", json={"rain": False})).json() == {"rain": False, "rush": 3.0}

    assert (await client.post("/api/sim/couriers/5/sem_sinal")).status_code == 503
    pubsub = redis.pubsub()
    await pubsub.subscribe("sim:commands")
    await pubsub.get_message(timeout=1)
    response = await client.post("/api/sim/couriers/5/parar", json={"seconds": 90})
    assert response.status_code == 202
    message = await pubsub.get_message(timeout=1)
    assert json.loads(message["data"]) == {"action": "parar", "courier_id": 5, "seconds": 90}
    assert (await client.post("/api/sim/couriers/5/explodir")).status_code == 422
    await pubsub.aclose()


async def test_entregador_humano_fica_fora_da_simulacao(client, city, redis):
    assert (await client.post("/api/couriers/3/online", json={"human": True})).status_code == 200
    humans = (await client.get("/api/couriers?human=true")).json()
    assert [c["id"] for c in humans] == [3]
    others = (await client.get("/api/couriers?human=false")).json()
    assert 3 not in [c["id"] for c in others] and len(others) == 3
