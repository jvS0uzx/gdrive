import json

from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import many, one, run
from app.events import emit

EVENTS = {
    "sinal_perdido": "sinal_perdido",
    "parado": "entregador_parado",
    "desvio": "desvio_de_rota",
    "atraso": "pedido_atrasado",
    "sem_entregador": "pedido_sem_entregador",
}
COURIER_KINDS = ("sinal_perdido", "parado", "desvio")
CUSTOMER_FACING = ("atraso", "sem_entregador")


async def open_alert(conn: AsyncConnection, order_id: int, kind: str, actor: str, **detail) -> bool:
    row = await one(
        conn,
        "INSERT INTO alerts (order_id, courier_id, kind, detail) "
        "SELECT id, courier_id, :kind, CAST(:detail AS jsonb) FROM orders WHERE id = :id "
        "ON CONFLICT DO NOTHING RETURNING id, opened_at",
        id=order_id,
        kind=kind,
        detail=json.dumps(detail),
    )
    if row is None:
        return False
    await emit(
        conn,
        order_id,
        EVENTS[kind],
        actor,
        timeline=kind in CUSTOMER_FACING,
        alert=kind,
        alert_id=row["id"],
        alert_at=int(row["opened_at"].timestamp() * 1000),
        **detail,
    )
    return True


async def close_alerts(conn: AsyncConnection, order_id: int, kinds: tuple[str, ...], actor: str) -> list[str]:
    rows = await many(
        conn,
        "UPDATE alerts SET closed_at = now() WHERE order_id = :id AND kind = ANY(:kinds) AND closed_at IS NULL "
        "RETURNING kind",
        id=order_id,
        kinds=list(kinds),
    )
    for row in rows:
        await emit(conn, order_id, "alerta_resolvido", actor, timeline=False, alert=row["kind"])
    return [row["kind"] for row in rows]


async def close_all(conn: AsyncConnection, order_id: int) -> None:
    await run(
        conn, "UPDATE alerts SET closed_at = now() WHERE order_id = :id AND closed_at IS NULL", id=order_id
    )
