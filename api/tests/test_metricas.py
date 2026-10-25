from prometheus_client import REGISTRY
from prometheus_client.parser import text_string_to_metric_families

from app.outbox import relay_once
from tests.conftest import online
from tests.test_pedido import create

REQUESTS = "gdrive_http_request_duration_seconds_count"


async def scraped(client, name, **labels):
    response = await client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    for family in text_string_to_metric_families(response.text):
        for sample in family.samples:
            if sample.name == name and sample.labels == labels:
                return sample.value
    return 0.0


def local(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0.0


async def test_metrics_conta_a_requisicao_pela_rota_declarada(client, city):
    store = city["stores"]["Acarajé da Dinha"]
    route = {"method": "GET", "route": "/api/stores/{store_id}"}
    ok = await scraped(client, REQUESTS, status="200", **route)
    missing = await scraped(client, REQUESTS, status="404", **route)

    assert (await client.get(f"/api/stores/{store}")).status_code == 200
    assert (await client.get("/api/stores/9999")).status_code == 404
    assert (await client.get("/nao/existe")).status_code == 404

    assert await scraped(client, REQUESTS, status="200", **route) == ok + 1
    assert await scraped(client, REQUESTS, status="404", **route) == missing + 1
    assert await scraped(client, REQUESTS, method="GET", route="sem_rota", status="404") >= 1
    text = (await client.get("/metrics")).text
    assert f'route="/api/stores/{store}"' not in text and "/nao/existe" not in text
    assert 'route="/metrics"' not in text


async def test_worker_mede_despacho_jobs_e_atraso_da_outbox(client, city, redis, jobs):
    dispatched = local("gdrive_jobs_total", kind="dispatch", result="ok")
    offered = local("gdrive_dispatch_seconds_count", result="oferta")
    relayed = local("gdrive_outbox_lag_seconds_count", topic="events.orders")
    lag = local("gdrive_outbox_lag_seconds_sum", topic="events.orders")

    await online(redis, client, 1)
    order = await create(client, city)
    await client.post(f"/api/stores/1/orders/{order}/accept", json={"prep_minutes": 5})
    await jobs()
    published = await relay_once(redis)

    assert local("gdrive_jobs_total", kind="dispatch", result="ok") == dispatched + 1
    assert local("gdrive_dispatch_seconds_count", result="oferta") == offered + 1
    assert local("gdrive_outbox_lag_seconds_count", topic="events.orders") == relayed + published
    assert 0 <= local("gdrive_outbox_lag_seconds_sum", topic="events.orders") - lag < 60 * published
