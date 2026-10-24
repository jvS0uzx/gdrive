import json

from app.db import one, transaction
from app.outbox import relay_once
from tests.conftest import online, outbox_types
from tests.test_pedido import arrive, create, offer_of


async def test_painel_da_loja(client, city, redis):
    store = city["stores"]["Acarajé da Dinha"]
    found = (await client.get("/api/stores?q=acaraj")).json()
    assert [s["id"] for s in found] == [store] and found[0]["manual"] is False
    assert (await client.get("/api/stores?q=nada-disso")).json() == []

    response = await client.put(f"/api/stores/{store}/manual", json={"manual": True})
    assert response.status_code == 200 and response.json()["manual"] is True
    created = await client.post(f"/api/stores/{store}/test-order")
    assert created.status_code == 201, created.text
    order = created.json()["id"]
    kinds, payloads = await outbox_types(order)
    assert kinds == ["pedido_criado"] and payloads[0]["manual"] is True

    listed = (await client.get(f"/api/stores/{store}/orders")).json()
    assert [o["id"] for o in listed] == [order] and listed[0]["status"] == "aguardando_loja"
    await client.post(f"/api/stores/{store}/orders/{order}/reject")
    other = await create(client, city)
    listed = (await client.get(f"/api/stores/{store}/orders")).json()
    assert [(o["id"], o["status"]) for o in listed] == [(other, "aguardando_loja"), (order, "recusado")]
    assert (await client.get("/api/stores/999")).status_code == 404
    far = city["stores"]["Pizzaria Longe"]
    response = await client.post(f"/api/stores/{far}/test-order")
    assert response.status_code == 422 and "4 km" in response.json()["error"]


async def test_entregador_ve_oferta_e_corrida_ativa(client, city, redis, jobs):
    await online(redis, client, 1)
    idle = (await client.get("/api/couriers/1")).json()
    assert idle["status"] == "livre" and idle["offer"] is None and idle["order"] is None
    assert idle["home"]["lat"] == -12.9845

    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    offered = (await client.get("/api/couriers/1")).json()
    assert offered["offer"]["order_id"] == order and offered["offer"]["store"]["name"] == "Acarajé da Dinha"
    assert offered["offer"]["customer"]["lat"] == -12.985

    offer = await offer_of(order)
    await client.post(f"/api/offers/{offer['id']}/accept", json={"courier_id": 1})
    busy = (await client.get("/api/couriers/1")).json()
    assert (
        busy["offer"] is None
        and busy["order"]["id"] == order
        and busy["order"]["status"] == "a_caminho_da_loja"
    )
    assert busy["order"]["ready_at"] is None
    assert (await client.get("/api/couriers/999")).status_code == 404


async def test_entrega_grava_o_trajeto_para_o_historico(client, city, redis, jobs):
    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await client.post(f"/api/stores/1/orders/{order}/ready")
    await jobs()
    offer = await offer_of(order)
    await client.post(f"/api/offers/{offer['id']}/accept")
    plan = {
        "from": [-38.48, -12.9845],
        "path": [[-38.48, -12.9845], [-38.48, -12.98]],
        "seconds": 60,
        "meters": 500,
    }
    await redis.hset(f"plan:{order}", "loja", json.dumps(plan))
    await redis.rpush(
        f"track:{order}:loja",
        "-38.480000,-12.984500,1000",
        "-38.480000,-12.982000,2000",
        "-38.480000,-12.980000,3000",
    )
    await redis.rpush(f"track:{order}:cliente", "-38.480000,-12.980000,4000", "-38.475000,-12.985000,9000")
    await arrive(order, "loja")
    await client.post(f"/api/orders/{order}/pickup", json={"courier_id": 1})
    assert (await client.get(f"/api/orders/{order}/track")).status_code == 404
    await arrive(order, "cliente")
    await client.post(f"/api/orders/{order}/deliver", json={"courier_id": 1})
    await jobs()
    await relay_once(redis)

    track = (await client.get(f"/api/orders/{order}/track")).json()
    loja, cliente = track["legs"]["loja"], track["legs"]["cliente"]
    assert loja["track"] == [[-38.48, -12.9845, 1000], [-38.48, -12.982, 2000], [-38.48, -12.98, 3000]]
    assert 495 < loja["meters"] < 505 and loja["planned_meters"] == 500 and len(loja["planned"]) == 2
    assert cliente["planned"] is None and cliente["courier_id"] == 1 and len(cliente["track"]) == 2
    assert track["timeline"][-1]["type"] == "pedido_entregue" and track["delivered_at"] is not None

    page = (await client.get("/api/history")).json()
    assert page["total"] == 1
    item = page["items"][0]
    assert item["id"] == order and item["store_name"] == "Acarajé da Dinha" and item["late"] is False
    assert item["meters"] > 1000 and item["seconds"] >= 0 and item["alerts"] == 0
    async with transaction() as conn:
        saved = await one(conn, "SELECT count(*) AS n FROM tracks WHERE order_id = :id", id=order)
    assert saved["n"] == 2
