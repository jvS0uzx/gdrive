import json

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncConnection

from app.config import settings
from app.db import many, one, run
from app.events import emit
from app.jobs import schedule

GEO_KEY = "geo:couriers"


async def dispatch(conn: AsyncConnection, order_id: int, redis: Redis, engine) -> str:
    order = await one(
        conn,
        "SELECT o.id, o.status, o.dispatch_radius_m, o.unassigned_alerted, sa.lat, sa.lon, "
        "now() - o.dispatch_started_at >= make_interval(secs => :alert) AS late "
        "FROM orders o JOIN stores s ON s.id = o.store_id JOIN addresses sa ON sa.id = s.address_id "
        "WHERE o.id = :id FOR UPDATE OF o",
        id=order_id,
        alert=float(settings.unassigned_alert_seconds),
    )
    if order is None or order["status"] != "em_preparo":
        return "ignorado"
    if await one(conn, "SELECT 1 FROM offers WHERE order_id = :id AND status = 'pendente'", id=order_id):
        return "ignorado"

    radius = order["dispatch_radius_m"]
    found = await redis.geosearch(
        GEO_KEY,
        longitude=order["lon"],
        latitude=order["lat"],
        radius=radius,
        unit="m",
        sort="ASC",
        count=50,
        withdist=True,
    )
    straight = {int(member): float(distance) for member, distance in found}
    nearby = list(straight)
    free: list[int] = []
    if nearby:
        rows = await many(
            conn,
            "SELECT c.id FROM couriers c WHERE c.id = ANY(:ids) AND c.status = 'livre' "
            "AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.courier_id = c.id AND (f.status = 'pendente' "
            "OR (f.order_id = :order AND f.status IN ('recusada', 'expirada')))) "
            "ORDER BY c.id FOR UPDATE OF c SKIP LOCKED",
            ids=nearby,
            order=order_id,
        )
        free = [row["id"] for row in rows]

    etas = await engine.etas(order["lat"], order["lon"], free) if free else []
    if etas:
        ranked = sorted(etas, key=lambda item: (item[1], item[0]))
        courier, seconds = ranked[0]
        candidates = [
            {"courier_id": c, "eta_seconds": round(s, 1), "distance_m": round(straight.get(c, 0.0))}
            for c, s in ranked
        ]
        offer = await one(
            conn,
            "INSERT INTO offers (order_id, courier_id, radius_m, eta_seconds, expires_at, candidates) VALUES "
            "(:order, :courier, :radius, :seconds, now() + make_interval(secs => :ttl), CAST(:candidates AS jsonb)) "
            "RETURNING id",
            order=order_id,
            courier=courier,
            radius=radius,
            seconds=seconds,
            ttl=float(settings.offer_seconds),
            candidates=json.dumps(candidates),
        )
        await emit(
            conn,
            order_id,
            "oferta_enviada",
            "despacho",
            offer_id=offer["id"],
            courier_id=courier,
            eta_seconds=seconds,
            radius_m=radius,
            expires_in=settings.offer_seconds,
        )
        await schedule(conn, "offer_timeout", delay=settings.offer_seconds, offer_id=offer["id"])
        return "oferta"

    bigger = [step for step in settings.radius_steps_m if step > radius]
    if bigger:
        await run(
            conn,
            "UPDATE orders SET dispatch_radius_m = :radius WHERE id = :id",
            id=order_id,
            radius=bigger[0],
        )
        await schedule(conn, "dispatch", delay=settings.dispatch_retry_seconds, order_id=order_id)
        return "ampliou"

    if order["late"] and not order["unassigned_alerted"]:
        await run(conn, "UPDATE orders SET unassigned_alerted = true WHERE id = :id", id=order_id)
        await emit(conn, order_id, "pedido_sem_entregador", "despacho", radius_m=radius)
    await schedule(conn, "dispatch", delay=settings.dispatch_retry_seconds, order_id=order_id)
    return "aguardando"
