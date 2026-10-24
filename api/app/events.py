import json

from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import one, run

ORDERS_STREAM = "events.orders"


async def emit(conn: AsyncConnection, order_id: int, kind: str, actor: str, **extra) -> dict:
    order = await one(conn, "SELECT id, status, version, courier_id FROM orders WHERE id = :id", id=order_id)
    await run(
        conn,
        "INSERT INTO order_events (order_id, type, status, actor) VALUES (:id, :kind, :status, :actor)",
        id=order_id,
        kind=kind,
        status=order["status"],
        actor=actor,
    )
    payload = {
        "type": kind,
        "order_id": order["id"],
        "version": order["version"],
        "status": order["status"],
        "courier_id": order["courier_id"],
        **extra,
    }
    await run(
        conn,
        "INSERT INTO outbox (topic, payload) VALUES (:topic, CAST(:payload AS jsonb))",
        topic=ORDERS_STREAM,
        payload=json.dumps(payload, default=str),
    )
    return payload
