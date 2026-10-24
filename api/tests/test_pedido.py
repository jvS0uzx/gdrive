import asyncio

from app.db import one, run, transaction
from tests.conftest import online, outbox_types


async def create(client, city, store="Acarajé da Dinha", customer=0):
    response = await client.post(
        "/api/orders", json={"store_id": city["stores"][store], "address_id": city["customers"][customer]}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def offer_of(order_id):
    async with transaction() as conn:
        return await one(
            conn,
            "SELECT id, courier_id, status FROM offers WHERE order_id = :id ORDER BY id DESC LIMIT 1",
            id=order_id,
        )


async def status_of(order_id):
    async with transaction() as conn:
        return (await one(conn, "SELECT status FROM orders WHERE id = :id", id=order_id))["status"]


async def arrive(order_id, phase):
    from app import orders

    async with transaction() as conn:
        await orders.arrived(conn, order_id, phase)


async def test_pedido_de_ponta_a_ponta(client, city, redis, jobs):
    await online(redis, client, 1, 2, 3)
    order = await create(client, city)
    assert (
        await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 12})
    ).status_code == 200
    await jobs()
    offer = await offer_of(order)
    assert offer["courier_id"] == 1 and offer["status"] == "pendente"

    response = await client.post(f"/api/offers/{offer['id']}/accept", json={"courier_id": 1})
    assert response.status_code == 200, response.text
    await arrive(order, "loja")
    assert (await client.post(f"/api/orders/{order}/pickup", json={"courier_id": 1})).status_code == 409
    assert (await client.post(f"/api/stores/1/orders/{order}/ready")).status_code == 200
    assert (await client.post(f"/api/orders/{order}/pickup", json={"courier_id": 1})).status_code == 200
    await arrive(order, "cliente")
    assert (await client.post(f"/api/orders/{order}/deliver", json={"courier_id": 1})).status_code == 200

    assert await status_of(order) == "entregue"
    detail = (await client.get(f"/api/orders/{order}")).json()
    assert detail["courier"]["id"] == 1
    assert [e["status"] for e in detail["timeline"]][-1] == "entregue"
    kinds, payloads = await outbox_types(order)
    assert kinds == [
        "pedido_criado",
        "pedido_aceito_pela_loja",
        "oferta_enviada",
        "entregador_atribuido",
        "entregador_chegou_na_loja",
        "pedido_pronto",
        "pedido_coletado",
        "entregador_chegou_no_cliente",
        "pedido_entregue",
    ]
    versions = [p["version"] for p in payloads]
    assert versions == sorted(versions) and versions[-1] > versions[0]
    couriers = {c["id"]: c["status"] for c in (await client.get("/api/couriers")).json()}
    assert couriers[1] == "livre"


async def test_transicao_fora_da_ordem_da_409(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    assert (await client.post(f"/api/stores/1/orders/{order}/ready")).status_code == 409
    assert (
        await client.post(f"/api/stores/2/orders/{order}/accept", json={"prep_minutes": 5})
    ).status_code == 404
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    assert (
        await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    ).status_code == 409
    assert (await client.post(f"/api/orders/{order}/deliver", json={"courier_id": 1})).status_code == 409
    await jobs()
    offer = await offer_of(order)
    await client.post(f"/api/offers/{offer['id']}/accept", json={"courier_id": 1})
    assert (await client.post(f"/api/orders/{order}/deliver", json={"courier_id": 1})).status_code == 409
    assert (await client.post(f"/api/orders/{order}/pickup", json={"courier_id": 2})).status_code == 409


async def test_dois_aceites_ao_mesmo_tempo_um_ganha(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offer = await offer_of(order)
    first, second = await asyncio.gather(
        client.post(f"/api/offers/{offer['id']}/accept"), client.post(f"/api/offers/{offer['id']}/accept")
    )
    assert sorted([first.status_code, second.status_code]) == [200, 409]
    assert await status_of(order) == "a_caminho_da_loja"


async def test_oferta_expirada_passa_para_o_proximo(client, city, redis, jobs):
    await online(redis, client, 1, 2)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    first = await offer_of(order)
    async with transaction() as conn:
        await run(
            conn, "UPDATE offers SET expires_at = now() - interval '1 second' WHERE id = :id", id=first["id"]
        )
    assert (await client.post(f"/api/offers/{first['id']}/accept")).status_code == 409
    await jobs(force=True)
    second = await offer_of(order)
    assert second["courier_id"] == 2 and second["id"] != first["id"]
    kinds, _ = await outbox_types(order)
    assert "oferta_expirada" in kinds


async def test_recusa_passa_para_o_proximo(client, city, redis, jobs):
    await online(redis, client, 1, 2)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    first = await offer_of(order)
    assert (
        await client.post(f"/api/offers/{first['id']}/decline", json={"courier_id": 1})
    ).status_code == 200
    await jobs()
    second = await offer_of(order)
    assert second["courier_id"] == 2


async def test_raio_cresce_e_alerta_sem_entregador(client, city, redis, jobs, engine):
    await online(redis, client, 3, 4)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})

    async def radius():
        async with transaction() as conn:
            return (await one(conn, "SELECT dispatch_radius_m FROM orders WHERE id = :id", id=order))[
                "dispatch_radius_m"
            ]

    await jobs()
    assert await radius() == 4000 and await offer_of(order) is None
    await jobs(force=True)
    offer = await offer_of(order)
    assert offer["courier_id"] == 3 and await radius() == 4000

    await client.post(f"/api/offers/{offer['id']}/decline")
    await jobs(force=True)
    assert await radius() == 6000
    async with transaction() as conn:
        await run(
            conn,
            "UPDATE orders SET dispatch_started_at = now() - interval '10 minutes' WHERE id = :id",
            id=order,
        )
    await jobs(force=True)
    await jobs(force=True)
    kinds, _ = await outbox_types(order)
    assert kinds.count("pedido_sem_entregador") == 1
    assert 4 not in sum(engine.eta_calls, [])


async def test_loja_que_nao_responde_recusa_sozinha(client, city, jobs):
    order = await create(client, city)
    await jobs()
    assert await status_of(order) == "aguardando_loja"
    await jobs(force=True)
    assert await status_of(order) == "recusado"
    kinds, _ = await outbox_types(order)
    assert kinds[-1] == "pedido_expirado_na_loja"


async def test_cancelamento_libera_entregador_e_depois_da_coleta_nao_vale(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offer = await offer_of(order)
    await client.post(f"/api/offers/{offer['id']}/accept")
    assert (await client.post(f"/api/orders/{order}/cancel")).status_code == 200
    couriers = {c["id"]: c["status"] for c in (await client.get("/api/couriers")).json()}
    assert couriers[1] == "livre"

    other = await create(client, city, customer=1)
    await client.post(f"/api/stores/1/orders/{other}/accept", json={"prep_minutes": 5})
    await client.post(f"/api/stores/1/orders/{other}/ready")
    await jobs()
    offer = await offer_of(other)
    await client.post(f"/api/offers/{offer['id']}/accept")
    await arrive(other, "loja")
    await client.post(f"/api/orders/{other}/pickup", json={"courier_id": 1})
    assert (await client.post(f"/api/orders/{other}/cancel")).status_code == 409


async def test_endereco_que_nao_e_de_cliente_da_404(client, city):
    response = await client.post("/api/orders", json={"store_id": 1, "address_id": 1})
    assert response.status_code == 404
