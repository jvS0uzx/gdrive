import json

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app import orders
from app.db import transaction

TRACKING_STREAM = "events.tracking"
GROUP = "workers"
PHASES = {"entregador_chegou_na_loja": "loja", "entregador_chegou_no_cliente": "cliente"}


async def ensure_group(redis: Redis) -> None:
    try:
        await redis.xgroup_create(TRACKING_STREAM, GROUP, id="0", mkstream=True)
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def consume_once(redis: Redis, consumer: str, block_ms: int = 2000) -> int:
    result = await redis.xreadgroup(GROUP, consumer, {TRACKING_STREAM: ">"}, count=50, block=block_ms)
    handled = 0
    for _, messages in result or []:
        for message_id, fields in messages:
            phase = PHASES.get(fields.get("type", ""))
            if phase:
                data = json.loads(fields["data"])
                try:
                    async with transaction() as conn:
                        await orders.arrived(conn, int(data["order_id"]), phase)
                except orders.Conflict, orders.NotFound:
                    pass
            await redis.xack(TRACKING_STREAM, GROUP, message_id)
            handled += 1
    return handled
