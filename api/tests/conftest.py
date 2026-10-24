import asyncio
import math
import os
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://postgres:gdrive@localhost:55432/gdrive_test")
os.environ.setdefault("REDIS_URL", "redis://localhost:56379/0")
os.environ["SEED_ON_START"] = "false"

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings
from app.db import many, run, transaction
from app.jobs import run_due
from app.main import app
from app.worker import handlers

ROOT = Path(__file__).resolve().parent.parent

STORES = {"Acarajé da Dinha": (-12.9800, -38.4800), "Pizzaria Longe": (-12.9000, -38.3500)}
CUSTOMERS = [(-12.9850, -38.4750), (-12.9900, -38.4700), (-12.9500, -38.4000)]
COURIERS = [(-12.9845, -38.4800), (-12.9910, -38.4800), (-13.0070, -38.4800), (-12.9000, -38.4000)]


def meters(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


class FakeEngine:
    def __init__(self, redis):
        self.redis = redis
        self.eta_calls = []

    async def route_seconds(self, origin, destination):
        return meters((origin["lat"], origin["lon"]), (destination["lat"], destination["lon"])) / 10

    async def etas(self, lat, lon, couriers):
        self.eta_calls.append(list(couriers))
        positions = await self.redis.geopos("geo:couriers", *[str(c) for c in couriers])
        return [
            (courier, meters((lat, lon), (pos[1], pos[0])) / 10)
            for courier, pos in zip(couriers, positions, strict=True)
            if pos
        ]

    async def addresses(self):
        return {
            "stores": [
                {"node": i, "lat": p[0], "lon": p[1], "name": n} for i, (n, p) in enumerate(STORES.items())
            ],
            "courier_homes": [{"node": 100 + i, "lat": p[0], "lon": p[1]} for i, p in enumerate(COURIERS)],
            "customers": [{"node": 200 + i, "lat": p[0], "lon": p[1]} for i, p in enumerate(CUSTOMERS)],
        }

    async def close(self):
        pass


async def reset_schema():
    engine = create_async_engine(settings.database_url)
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await engine.dispose()


@pytest.fixture(scope="session", autouse=True)
def schema():
    asyncio.run(reset_schema())
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT, check=True)


@pytest.fixture
async def redis():
    client = Redis.from_url(settings.redis_url, decode_responses=True)
    await client.flushdb()
    yield client
    await client.aclose()


@pytest.fixture
async def engine(redis):
    return FakeEngine(redis)


@pytest.fixture(autouse=True)
async def clean():
    async with transaction() as conn:
        await conn.execute(
            text(
                "TRUNCATE jobs, outbox, offers, order_events, orders, couriers, stores, addresses RESTART IDENTITY CASCADE"
            )
        )


@pytest.fixture
async def city(engine):
    from app.seed import seed_if_empty

    await seed_if_empty(engine)
    async with transaction() as conn:
        stores = await many(conn, "SELECT id, name FROM stores ORDER BY id")
        customers = await many(conn, "SELECT id FROM addresses WHERE kind = 'customer' ORDER BY id")
    return {"stores": {s["name"]: s["id"] for s in stores}, "customers": [c["id"] for c in customers]}


@pytest.fixture
async def client(redis, engine):
    app.state.engine = engine
    app.state.redis = redis
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def jobs(redis, engine):
    table = handlers(redis, engine)

    async def drain(force: bool = False) -> int:
        if force:
            async with transaction() as conn:
                await run(conn, "UPDATE jobs SET run_at = now() WHERE done_at IS NULL")
        total = 0
        for _ in range(20):
            done = await run_due(table)
            total += done
            if not done:
                break
        return total

    return drain


async def online(redis, client, *courier_ids):
    for courier_id in courier_ids:
        lat, lon = COURIERS[courier_id - 1]
        await redis.geoadd("geo:couriers", (lon, lat, str(courier_id)))
        response = await client.post(f"/api/couriers/{courier_id}/online")
        assert response.status_code == 200, response.text


async def outbox_types(order_id=None):
    async with transaction() as conn:
        rows = await many(conn, "SELECT payload FROM outbox ORDER BY id")
    from app.db import loads

    payloads = [loads(r["payload"]) for r in rows]
    return [p["type"] for p in payloads if order_id is None or p["order_id"] == order_id], payloads
