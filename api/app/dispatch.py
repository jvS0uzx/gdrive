import json
import time

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncConnection

from app.alerts import open_alert
from app.config import settings
from app.db import many, one, run
from app.events import emit
from app.jobs import schedule

GEO_KEY = "geo:couriers"

FREE = (
    "SELECT c.id FROM couriers c WHERE c.id = ANY(:ids) AND c.status = 'livre' "
    "AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.courier_id = c.id AND (f.status = 'pendente' "
    "OR (f.order_id = :order AND f.status IN ('recusada', 'expirada', 'aceita')))) ORDER BY c.id"
)


# O índice geográfico tem todo mundo, livre ou não, e quem está livre só o Postgres sabe. Com
# muitos entregadores, os 50 mais próximos podem estar todos ocupados: a busca abre em lotes
# até achar WANTED livres ou esgotar o raio.
SEARCH_BATCHES = (50, 200, 800, 3200)
WANTED = 50


async def free_nearby(
    conn: AsyncConnection, redis: Redis, lat: float, lon: float, radius: int, order_id: int, lock: bool
) -> tuple[dict[int, float], list[int]]:
    straight: dict[int, float] = {}
    free: set[int] = set()
    oldest = time.time() * 1000 - settings.signal_lost_seconds * 1000
    for count in SEARCH_BATCHES:
        found = await redis.geosearch(
            GEO_KEY,
            longitude=lon,
            latitude=lat,
            radius=radius,
            unit="m",
            sort="ASC",
            count=count,
            withdist=True,
        )
        batch = [(int(member), float(distance)) for member, distance in found if int(member) not in straight]
        straight.update(batch)
        if batch:
            pipe = redis.pipeline(transaction=False)
            for courier, _ in batch:
                pipe.hget(f"courier:{courier}", "ts")
            stamps = await pipe.execute()
            fresh = [
                c for (c, _), ts in zip(batch, stamps, strict=True) if ts is not None and float(ts) >= oldest
            ]
            if fresh:
                rows = await many(
                    conn, FREE + (" FOR UPDATE OF c SKIP LOCKED" if lock else ""), ids=fresh, order=order_id
                )
                free.update(row["id"] for row in rows)
        if len(free) >= WANTED or len(found) < count:
            break
    return straight, sorted(free, key=lambda c: (straight[c], c))[:WANTED]


def ranking(etas: list[tuple[int, float]], straight: dict[int, float]) -> list[dict]:
    return [
        {"courier_id": c, "eta_seconds": round(s, 1), "distance_m": round(straight.get(c, 0.0))}
        for c, s in sorted(etas, key=lambda item: (item[1], item[0]))
    ]


async def dispatch(conn: AsyncConnection, order_id: int, redis: Redis, engine) -> str:
    order = await one(
        conn,
        "SELECT o.id, o.status, o.dispatch_radius_m, sa.lat, sa.lon, "
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
    straight, free = await free_nearby(conn, redis, order["lat"], order["lon"], radius, order_id, lock=True)
    etas = await engine.etas(order["lat"], order["lon"], free) if free else []
    if etas:
        candidates = ranking(etas, straight)
        courier, seconds = candidates[0]["courier_id"], candidates[0]["eta_seconds"]
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

    if order["late"]:
        await open_alert(conn, order_id, "sem_entregador", "despacho", radius_m=radius)
    await schedule(conn, "dispatch", delay=settings.dispatch_retry_seconds, order_id=order_id)
    return "aguardando"
