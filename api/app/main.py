import asyncio
import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Path, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from app import orders
from app.config import settings
from app.db import loads, many, one, run, transaction
from app.dispatch import free_nearby, ranking
from app.engine import Engine
from app.seed import seed_if_empty

log = logging.getLogger("gdrive.api")

WEATHER_KEY = "city:weather"
SIM_CONTROL_KEY = "sim:control"
SIM_COMMANDS = "sim:commands"


async def seed_when_ready(engine: Engine) -> None:
    for attempt in range(60):
        try:
            if await seed_if_empty(engine):
                log.info("carga inicial de endereços, lojas e entregadores feita")
            return
        except httpx.HTTPError as exc:
            log.warning("engine indisponível para a carga inicial (%s), tentativa %d", exc, attempt + 1)
            await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = Engine(settings.engine_url)
    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
    if settings.seed_on_start:
        await seed_when_ready(app.state.engine)
    yield
    await app.state.engine.close()
    await app.state.redis.aclose()


app = FastAPI(title="GDrive API", lifespan=lifespan)


@app.exception_handler(orders.Conflict)
async def conflict(_: Request, exc: orders.Conflict):
    return JSONResponse(status_code=409, content={"error": str(exc)})


@app.exception_handler(orders.NotFound)
async def not_found(_: Request, exc: orders.NotFound):
    return JSONResponse(status_code=404, content={"error": str(exc)})


class OrderIn(BaseModel):
    store_id: int
    address_id: int


class AcceptIn(BaseModel):
    prep_minutes: int = Field(ge=1, le=120)


class CourierIn(BaseModel):
    courier_id: int


class MaybeCourier(BaseModel):
    courier_id: int | None = None


class OnlineIn(BaseModel):
    human: bool | None = None


class SimIn(BaseModel):
    rain: bool | None = None
    rush: float | None = Field(default=None, ge=1, le=10)


class SimCommandIn(BaseModel):
    seconds: int = Field(default=60, ge=5, le=600)


@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}


@app.post("/api/orders", status_code=201)
async def create_order(body: OrderIn, request: Request):
    async with transaction() as conn:
        store, customer = await orders.endpoints(conn, body.store_id, body.address_id)
    try:
        travel = await request.app.state.engine.route_seconds(
            {"lat": store["lat"], "lon": store["lon"]}, {"lat": customer["lat"], "lon": customer["lon"]}
        )
    except httpx.HTTPError:
        return JSONResponse(status_code=503, content={"error": "roteador indisponível"})
    async with transaction() as conn:
        order_id = await orders.create(conn, store, customer, travel)
        row = await one(conn, "SELECT id, status, promised_at FROM orders WHERE id = :id", id=order_id)
    return dict(row)


@app.get("/api/orders")
async def list_orders(status: str | None = None, limit: int = 50):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT o.id, o.status, o.store_id, s.name AS store_name, o.courier_id, o.created_at, o.updated_at "
            "FROM orders o JOIN stores s ON s.id = o.store_id "
            "WHERE CAST(:status AS text) IS NULL OR o.status = :status ORDER BY o.id DESC LIMIT :limit",
            status=status,
            limit=min(limit, 500),
        )
    return [dict(row) for row in rows]


@app.get("/api/orders/{order_id}")
async def get_order(order_id: int):
    async with transaction() as conn:
        ctx = await orders.context(conn, order_id)
        timeline = await many(
            conn,
            "SELECT type, status, actor, at FROM order_events WHERE order_id = :id ORDER BY id",
            id=order_id,
        )
        courier = None
        if ctx["courier_id"] is not None:
            courier = dict(
                await one(conn, "SELECT id, name FROM couriers WHERE id = :id", id=ctx["courier_id"])
            )
    return {
        "id": ctx["id"],
        "status": ctx["status"],
        "version": ctx["version"],
        "store": {"id": ctx["store_id"], "name": ctx["store_name"], **orders.store_point(ctx)},
        "customer": orders.customer_point(ctx),
        "courier": courier,
        "prep_minutes": ctx["prep_minutes"],
        "ready_at": ctx["ready_at"],
        "promised_at": ctx["promised_at"],
        "created_at": ctx["created_at"],
        "timeline": [dict(row) for row in timeline],
    }


@app.get("/api/orders/{order_id}/dispatch")
async def order_dispatch(order_id: int):
    async with transaction() as conn:
        await orders.context(conn, order_id)
        offers = await many(
            conn,
            "SELECT id, courier_id, status, radius_m, eta_seconds, candidates, created_at, expires_at "
            "FROM offers WHERE order_id = :id ORDER BY id",
            id=order_id,
        )
    return {
        "order_id": order_id,
        "offers": [{**dict(o), "candidates": loads(o["candidates"])} for o in offers],
    }


@app.get("/api/orders/{order_id}/candidates")
async def order_candidates(order_id: int, request: Request):
    async with transaction() as conn:
        ctx = await orders.context(conn, order_id)
        straight, free = await free_nearby(
            conn,
            request.app.state.redis,
            ctx["store_lat"],
            ctx["store_lon"],
            settings.radius_steps_m[-1],
            order_id,
            lock=False,
        )
    try:
        etas = await request.app.state.engine.etas(ctx["store_lat"], ctx["store_lon"], free) if free else []
    except httpx.HTTPError:
        return JSONResponse(status_code=503, content={"error": "roteador indisponível"})
    return ranking(etas, straight)[:10]


@app.post("/api/orders/{order_id}/assign")
async def order_assign(order_id: int, body: CourierIn):
    async with transaction() as conn:
        await orders.assign(conn, order_id, body.courier_id)
    return {"status": "a_caminho_da_loja", "courier_id": body.courier_id}


@app.post("/api/orders/{order_id}/unassign")
async def order_unassign(order_id: int):
    async with transaction() as conn:
        courier = await orders.unassign(conn, order_id)
    return {"status": "em_preparo", "courier_id": courier}


@app.get("/api/alerts")
async def list_alerts(open: bool = True, limit: int = 100):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT a.id, a.order_id, a.courier_id, a.kind, a.detail, a.opened_at, a.closed_at, "
            "o.status, s.name AS store_name FROM alerts a JOIN orders o ON o.id = a.order_id "
            "JOIN stores s ON s.id = o.store_id WHERE NOT :open OR a.closed_at IS NULL "
            "ORDER BY a.id DESC LIMIT :limit",
            open=open,
            limit=min(limit, 500),
        )
    return [{**dict(row), "detail": loads(row["detail"])} for row in rows]


@app.post("/api/orders/{order_id}/cancel")
async def cancel_order(order_id: int):
    async with transaction() as conn:
        await orders.cancel(conn, order_id)
    return {"status": "cancelado"}


@app.post("/api/stores/{store_id}/orders/{order_id}/accept")
async def store_accept(store_id: int, order_id: int, body: AcceptIn):
    async with transaction() as conn:
        await orders.accept_by_store(conn, store_id, order_id, body.prep_minutes)
    return {"status": "em_preparo"}


@app.post("/api/stores/{store_id}/orders/{order_id}/reject")
async def store_reject(store_id: int, order_id: int):
    async with transaction() as conn:
        await orders.reject_by_store(conn, store_id, order_id)
    return {"status": "recusado"}


@app.post("/api/stores/{store_id}/orders/{order_id}/ready")
async def store_ready(store_id: int, order_id: int):
    async with transaction() as conn:
        await orders.ready(conn, store_id, order_id)
    return {"ready": True}


@app.get("/api/stores")
async def list_stores(limit: int = 2000, offset: int = 0):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT s.id, s.name, a.lat, a.lon FROM stores s JOIN addresses a ON a.id = s.address_id "
            "ORDER BY s.id LIMIT :limit OFFSET :offset",
            limit=min(limit, 5000),
            offset=offset,
        )
    return [dict(row) for row in rows]


@app.get("/api/couriers")
async def list_couriers(
    status: str | None = None, human: bool | None = None, limit: int = 100, offset: int = 0
):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT c.id, c.name, c.status, c.human, a.lat, a.lon FROM couriers c "
            "JOIN addresses a ON a.id = c.home_address_id "
            "WHERE (CAST(:status AS text) IS NULL OR c.status = :status) "
            "AND (CAST(:human AS boolean) IS NULL OR c.human = :human) ORDER BY c.id LIMIT :limit OFFSET :offset",
            status=status,
            human=human,
            limit=min(limit, 5000),
            offset=offset,
        )
    return [dict(row) for row in rows]


@app.post("/api/couriers/{courier_id}/online")
async def courier_online(courier_id: int, body: OnlineIn | None = None):
    async with transaction() as conn:
        await orders.go_online(conn, courier_id)
        if body is not None and body.human is not None:
            await run(
                conn, "UPDATE couriers SET human = :human WHERE id = :id", id=courier_id, human=body.human
            )
    return {"status": "livre"}


@app.post("/api/couriers/{courier_id}/offline")
async def courier_offline(courier_id: int):
    async with transaction() as conn:
        await orders.go_offline(conn, courier_id)
    return {"status": "offline"}


@app.post("/api/offers/{offer_id}/accept")
async def offer_accept(offer_id: int, body: MaybeCourier | None = None):
    async with transaction() as conn:
        order_id = await orders.accept_offer(conn, offer_id, body.courier_id if body else None)
    return {"order_id": order_id, "status": "a_caminho_da_loja"}


@app.post("/api/offers/{offer_id}/decline")
async def offer_decline(offer_id: int, body: MaybeCourier | None = None):
    async with transaction() as conn:
        await orders.decline_offer(conn, offer_id, body.courier_id if body else None)
    return {"status": "recusada"}


@app.post("/api/orders/{order_id}/pickup")
async def pickup(order_id: int, body: CourierIn):
    async with transaction() as conn:
        await orders.pickup(conn, order_id, body.courier_id)
    return {"status": "em_rota"}


@app.post("/api/orders/{order_id}/deliver")
async def deliver(order_id: int, body: CourierIn):
    async with transaction() as conn:
        await orders.deliver(conn, order_id, body.courier_id)
    return {"status": "entregue"}


@app.get("/api/addresses")
async def list_addresses(kind: str = "customer", limit: int = 500, offset: int = 0):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT id, node_id, lat, lon FROM addresses WHERE kind = :kind ORDER BY id LIMIT :limit OFFSET :offset",
            kind=kind,
            limit=min(limit, 20000),
            offset=offset,
        )
    return [dict(row) for row in rows]


async def sim_state(redis: Redis) -> dict:
    rain = await redis.hget(WEATHER_KEY, "rain")
    rush = await redis.hget(SIM_CONTROL_KEY, "rush")
    return {"rain": rain == "1", "rush": float(rush) if rush else 1.0}


@app.get("/api/sim")
async def get_sim(request: Request):
    return await sim_state(request.app.state.redis)


@app.put("/api/sim")
async def put_sim(body: SimIn, request: Request):
    redis = request.app.state.redis
    if body.rain is not None:
        await redis.hset(WEATHER_KEY, "rain", "1" if body.rain else "0")
    if body.rush is not None:
        await redis.hset(SIM_CONTROL_KEY, "rush", str(body.rush))
    return await sim_state(redis)


@app.post("/api/sim/couriers/{courier_id}/{action}", status_code=202)
async def sim_command(
    courier_id: int,
    request: Request,
    action: str = Path(pattern="^(sem_sinal|parar|desviar)$"),
    body: SimCommandIn | None = None,
):
    seconds = body.seconds if body else 60
    message = json.dumps({"action": action, "courier_id": courier_id, "seconds": seconds})
    receivers = await request.app.state.redis.publish(SIM_COMMANDS, message)
    if receivers == 0:
        return JSONResponse(status_code=503, content={"error": "simulador fora do ar"})
    return {"action": action, "courier_id": courier_id, "seconds": seconds}


@app.get("/api/stats")
async def stats():
    async with transaction() as conn:
        by_status = await many(conn, "SELECT status, count(*) AS n FROM orders GROUP BY status")
        couriers = await many(conn, "SELECT status, count(*) AS n FROM couriers GROUP BY status")
        delivered = await one(
            conn,
            "SELECT count(*) AS n, avg(extract(epoch FROM updated_at - created_at)) AS seconds "
            "FROM orders WHERE status = 'entregue'",
        )
    return {
        "orders": {row["status"]: row["n"] for row in by_status},
        "couriers": {row["status"]: row["n"] for row in couriers},
        "delivered": delivered["n"],
        "avg_delivery_seconds": float(delivered["seconds"]) if delivered["seconds"] is not None else None,
    }
