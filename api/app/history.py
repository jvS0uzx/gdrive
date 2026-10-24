import json

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import loads, many, one, run

PHASES = ("loja", "cliente")


def parse_track(points: list[str]) -> list[tuple[float, float, float]]:
    out = []
    for raw in points:
        parts = raw.split(",")
        if len(parts) == 3:
            try:
                out.append((float(parts[0]), float(parts[1]), float(parts[2])))
            except ValueError:
                continue
    return out


async def save_track(conn: AsyncConnection, redis: Redis, order_id: int) -> int:
    order = await one(conn, "SELECT courier_id FROM orders WHERE id = :id", id=order_id)
    if order is None:
        return 0
    plans = await redis.hgetall(f"plan:{order_id}")
    saved = 0
    for phase in PHASES:
        points = parse_track(await redis.lrange(f"track:{order_id}:{phase}", 0, -1))
        if len(points) < 2:
            continue
        plan = json.loads(plans[phase]) if phase in plans else None
        planned = plan["path"] if plan and len(plan.get("path") or []) >= 2 else None
        saved += await run(
            conn,
            "INSERT INTO tracks (order_id, phase, courier_id, geom, meters, planned, planned_seconds, planned_meters) "
            "SELECT :id, :phase, :courier, g, ST_Length(g::geography), ST_GeomFromText(:planned, 4326), "
            ":planned_seconds, :planned_meters FROM (SELECT ST_GeomFromText(:wkt, 4326) AS g) x "
            "ON CONFLICT (order_id, phase) DO NOTHING",
            id=order_id,
            phase=phase,
            courier=order["courier_id"],
            wkt="LINESTRING M (" + ", ".join(f"{lon} {lat} {at}" for lon, lat, at in points) + ")",
            planned="LINESTRING (" + ", ".join(f"{lon} {lat}" for lon, lat in planned) + ")"
            if planned
            else None,
            planned_seconds=plan["seconds"] if planned else None,
            planned_meters=plan["meters"] if planned else None,
        )
    return saved


async def legs(conn: AsyncConnection, order_id: int) -> dict:
    rows = await many(
        conn,
        "SELECT t.phase, t.courier_id, t.meters, t.planned_seconds, t.planned_meters, "
        "(SELECT json_agg(json_build_array(ST_X(d.geom), ST_Y(d.geom), ST_M(d.geom)) ORDER BY d.path) "
        "FROM ST_DumpPoints(t.geom) d) AS track, ST_AsGeoJSON(t.planned) AS planned "
        "FROM tracks t WHERE t.order_id = :id",
        id=order_id,
    )
    return {
        row["phase"]: {
            "courier_id": row["courier_id"],
            "meters": round(row["meters"], 1),
            "track": loads(row["track"]),
            "planned": loads(row["planned"])["coordinates"] if row["planned"] else None,
            "planned_seconds": row["planned_seconds"],
            "planned_meters": row["planned_meters"],
        }
        for row in rows
    }
