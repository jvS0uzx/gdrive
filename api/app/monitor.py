import time

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncConnection

from app.alerts import close_alerts, open_alert
from app.config import settings
from app.db import many, one, transaction
from app.orders import ACTIVE, FINAL

TRACKED = {
    "entregador_parado": ("parado", True),
    "entregador_em_movimento": ("parado", False),
    "desvio_de_rota": ("desvio", True),
    "rota_retomada": ("desvio", False),
}


async def watch_signal(redis: Redis) -> int:
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT o.id, o.courier_id, EXISTS (SELECT 1 FROM alerts a WHERE a.order_id = o.id "
            "AND a.kind = 'sinal_perdido' AND a.closed_at IS NULL) AS lost "
            "FROM orders o WHERE o.status = ANY(:active) AND o.courier_id IS NOT NULL ORDER BY o.id",
            active=list(ACTIVE),
        )
        if not rows:
            return 0
        pipe = redis.pipeline(transaction=False)
        for row in rows:
            pipe.hget(f"courier:{row['courier_id']}", "ts")
        stamps = await pipe.execute()
        now = time.time() * 1000
        changed = 0
        for row, ts in zip(rows, stamps, strict=True):
            silent_ms = now - float(ts) if ts is not None else None
            silent = silent_ms is None or silent_ms > settings.signal_lost_seconds * 1000
            if silent and not row["lost"]:
                seconds = round(silent_ms / 1000) if silent_ms is not None else None
                changed += await open_alert(
                    conn, row["id"], "sinal_perdido", "sistema", silent_seconds=seconds
                )
            elif not silent and row["lost"]:
                changed += len(await close_alerts(conn, row["id"], ("sinal_perdido",), "sistema"))
        return changed


async def check_late(conn: AsyncConnection, order_id: int) -> None:
    row = await one(conn, "SELECT status FROM orders WHERE id = :id", id=order_id)
    if row is not None and row["status"] not in FINAL:
        await open_alert(conn, order_id, "atraso", "sistema")


async def from_tracking(conn: AsyncConnection, kind: str, data: dict) -> None:
    alert, opening = TRACKED[kind]
    order_id = int(data["order_id"])
    row = await one(conn, "SELECT courier_id, status FROM orders WHERE id = :id FOR UPDATE", id=order_id)
    if row is None or row["courier_id"] != int(data["courier_id"]) or row["status"] not in ACTIVE:
        return
    if opening:
        detail = {key: data[key] for key in ("meters", "seconds") if key in data}
        await open_alert(conn, order_id, alert, "rastreio", **detail)
    else:
        await close_alerts(conn, order_id, (alert,), "rastreio")
