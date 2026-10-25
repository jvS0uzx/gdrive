import json
from datetime import UTC, datetime

from redis.asyncio import Redis
from redis.asyncio.client import Pipeline

from app.db import loads, many, run, transaction
from app.metrics import OUTBOX_LAG


def target_key(courier_id: int) -> str:
    return f"target:{courier_id}"


def side_effects(pipe: Pipeline, payload: dict) -> None:
    courier = payload.get("courier_id")
    kind = payload["type"]
    if kind in ("entregador_atribuido", "pedido_coletado") and courier:
        point = payload["store"] if kind == "entregador_atribuido" else payload["customer"]
        key = target_key(courier)
        pipe.delete(key)
        pipe.hset(
            key,
            mapping={
                "order_id": payload["order_id"],
                "lat": point["lat"],
                "lon": point["lon"],
                "phase": "loja" if kind == "entregador_atribuido" else "cliente",
                "version": payload["version"],
            },
        )
    elif kind in ("pedido_entregue", "pedido_cancelado", "entregador_desatribuido") and courier:
        pipe.delete(target_key(courier))
    if kind == "entregador_desatribuido":
        pipe.hdel(f"plan:{payload['order_id']}", "loja")
        pipe.delete(f"track:{payload['order_id']}:loja")


async def relay_once(redis: Redis, limit: int = 200) -> int:
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT id, topic, payload, created_at FROM outbox WHERE published_at IS NULL ORDER BY id "
            "LIMIT :limit FOR UPDATE SKIP LOCKED",
            limit=limit,
        )
        if not rows:
            return 0
        pipe = redis.pipeline(transaction=False)
        for row in rows:
            payload = loads(row["payload"])
            pipe.xadd(
                row["topic"],
                {"type": payload["type"], "data": json.dumps(payload)},
                maxlen=200_000,
                approximate=True,
            )
            side_effects(pipe, payload)
        await pipe.execute()
        # created_at é o now() da transação que gravou o evento: o atraso inclui o resto dela.
        published = datetime.now(UTC)
        for row in rows:
            OUTBOX_LAG.labels(row["topic"]).observe((published - row["created_at"]).total_seconds())
        await run(
            conn,
            "UPDATE outbox SET published_at = now() WHERE id = ANY(:ids)",
            ids=[row["id"] for row in rows],
        )
        return len(rows)
