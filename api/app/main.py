import asyncio
import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Path, Request
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from app import orders
from app.config import settings
from app.db import loads, many, one, run, transaction
from app.dispatch import free_nearby, ranking
from app.engine import Engine
from app.history import legs
from app.metrics import HttpMetrics
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
app.add_middleware(HttpMetrics)


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


class ManualIn(BaseModel):
    manual: bool


class SimIn(BaseModel):
    rain: bool | None = None
    rush: float | None = Field(default=None, ge=1, le=10)


class SimCommandIn(BaseModel):
    seconds: int = Field(default=60, ge=5, le=600)


@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/metrics", include_in_schema=False)
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


async def place_order(request: Request, store_id: int, address_id: int):
    async with transaction() as conn:
        store, customer = await orders.endpoints(conn, store_id, address_id)
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


@app.post("/api/orders", status_code=201)
async def create_order(body: OrderIn, request: Request):
    return await place_order(request, body.store_id, body.address_id)


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
        "store": {
            "id": ctx["store_id"],
            "name": ctx["store_name"],
            "manual": ctx["store_manual"],
            **orders.store_point(ctx),
        },
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
async def list_stores(q: str | None = None, limit: int = 2000, offset: int = 0):
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT s.id, s.name, s.manual, a.lat, a.lon FROM stores s JOIN addresses a ON a.id = s.address_id "
            "WHERE CAST(:q AS text) IS NULL OR lower(s.name) LIKE '%' || lower(:q) || '%' "
            "ORDER BY s.id LIMIT :limit OFFSET :offset",
            q=q.strip() if q and q.strip() else None,
            limit=min(limit, 5000),
            offset=offset,
        )
    return [dict(row) for row in rows]


async def store_or_404(conn, store_id: int):
    store = await one(
        conn,
        "SELECT s.id, s.name, s.manual, s.default_prep_minutes, a.lat, a.lon FROM stores s "
        "JOIN addresses a ON a.id = s.address_id WHERE s.id = :id",
        id=store_id,
    )
    if store is None:
        raise orders.NotFound("loja não existe")
    return store


@app.get("/api/stores/{store_id}")
async def get_store(store_id: int):
    async with transaction() as conn:
        return dict(await store_or_404(conn, store_id))


@app.put("/api/stores/{store_id}/manual")
async def set_store_manual(store_id: int, body: ManualIn):
    async with transaction() as conn:
        await store_or_404(conn, store_id)
        await run(conn, "UPDATE stores SET manual = :manual WHERE id = :id", id=store_id, manual=body.manual)
        return dict(await store_or_404(conn, store_id))


@app.get("/api/stores/{store_id}/orders")
async def store_orders(store_id: int, recent: int = 15):
    async with transaction() as conn:
        await store_or_404(conn, store_id)
        rows = await many(
            conn,
            "(SELECT o.id, o.status, o.created_at, o.updated_at, o.prep_minutes, o.ready_at, o.promised_at, "
            "o.courier_id, c.name AS courier_name, ca.lat AS customer_lat, ca.lon AS customer_lon "
            "FROM orders o LEFT JOIN couriers c ON c.id = o.courier_id JOIN addresses ca ON ca.id = o.address_id "
            "WHERE o.store_id = :id AND o.status NOT IN ('entregue', 'recusado', 'cancelado')) "
            "UNION ALL (SELECT o.id, o.status, o.created_at, o.updated_at, o.prep_minutes, o.ready_at, "
            "o.promised_at, o.courier_id, c.name, ca.lat, ca.lon FROM orders o "
            "LEFT JOIN couriers c ON c.id = o.courier_id JOIN addresses ca ON ca.id = o.address_id "
            "WHERE o.store_id = :id AND o.status IN ('entregue', 'recusado', 'cancelado') "
            "ORDER BY o.updated_at DESC LIMIT :recent) ORDER BY id DESC",
            id=store_id,
            recent=min(recent, 100),
        )
    return [dict(row) for row in rows]


@app.post("/api/stores/{store_id}/test-order", status_code=201)
async def store_test_order(store_id: int, request: Request):
    async with transaction() as conn:
        await store_or_404(conn, store_id)
        customer = await one(
            conn,
            "SELECT c.id FROM addresses c, stores s JOIN addresses sa ON sa.id = s.address_id "
            "WHERE s.id = :id AND c.kind = 'customer' "
            "AND ST_DWithin(c.geom::geography, sa.geom::geography, 4000) "
            "AND NOT ST_DWithin(c.geom::geography, sa.geom::geography, 300) ORDER BY random() LIMIT 1",
            id=store_id,
        )
    if customer is None:
        return JSONResponse(status_code=422, content={"error": "nenhum cliente entre 300 m e 4 km da loja"})
    return await place_order(request, store_id, customer["id"])


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


@app.get("/api/couriers/{courier_id}")
async def get_courier(courier_id: int):
    async with transaction() as conn:
        courier = await one(
            conn,
            "SELECT c.id, c.name, c.status, c.human, a.lat, a.lon FROM couriers c "
            "JOIN addresses a ON a.id = c.home_address_id WHERE c.id = :id",
            id=courier_id,
        )
        if courier is None:
            raise orders.NotFound("entregador não existe")
        offer = await one(
            conn,
            "SELECT f.id, f.order_id, f.eta_seconds, f.expires_at, s.name AS store_name, sa.lat AS store_lat, "
            "sa.lon AS store_lon, ca.lat AS customer_lat, ca.lon AS customer_lon FROM offers f "
            "JOIN orders o ON o.id = f.order_id JOIN stores s ON s.id = o.store_id "
            "JOIN addresses sa ON sa.id = s.address_id JOIN addresses ca ON ca.id = o.address_id "
            "WHERE f.courier_id = :id AND f.status = 'pendente' AND f.expires_at > now()",
            id=courier_id,
        )
        order = await one(
            conn,
            "SELECT o.id FROM orders o WHERE o.courier_id = :id AND o.status = ANY(:active)",
            id=courier_id,
            active=list(orders.ACTIVE),
        )
        active = await orders.context(conn, order["id"]) if order else None
    return {
        "id": courier["id"],
        "name": courier["name"],
        "status": courier["status"],
        "human": courier["human"],
        "home": {"lat": courier["lat"], "lon": courier["lon"]},
        "offer": {
            "id": offer["id"],
            "order_id": offer["order_id"],
            "eta_seconds": offer["eta_seconds"],
            "expires_at": offer["expires_at"],
            "store": {"name": offer["store_name"], "lat": offer["store_lat"], "lon": offer["store_lon"]},
            "customer": {"lat": offer["customer_lat"], "lon": offer["customer_lon"]},
        }
        if offer
        else None,
        "order": {
            "id": active["id"],
            "status": active["status"],
            "ready_at": active["ready_at"],
            "store": {"id": active["store_id"], "name": active["store_name"], **orders.store_point(active)},
            "customer": orders.customer_point(active),
        }
        if active
        else None,
    }


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


@app.get("/api/history")
async def history(limit: int = 50, offset: int = 0):
    async with transaction() as conn:
        total = await one(conn, "SELECT count(*) AS n FROM orders WHERE status = 'entregue'")
        rows = await many(
            conn,
            "SELECT o.id, s.name AS store_name, o.courier_id, c.name AS courier_name, o.created_at, "
            "o.delivered_at, o.promised_at, "
            "extract(epoch FROM o.delivered_at - o.created_at) AS seconds, o.delivered_at > o.promised_at AS late, "
            "(SELECT sum(t.meters) FROM tracks t WHERE t.order_id = o.id) AS meters, "
            "(SELECT count(*) FROM alerts a WHERE a.order_id = o.id) AS alerts "
            "FROM orders o JOIN stores s ON s.id = o.store_id LEFT JOIN couriers c ON c.id = o.courier_id "
            "WHERE o.status = 'entregue' "
            "ORDER BY o.delivered_at DESC NULLS LAST, o.id DESC LIMIT :limit OFFSET :offset",
            limit=min(limit, 200),
            offset=offset,
        )
    items = [
        {
            **dict(row),
            "seconds": float(row["seconds"]) if row["seconds"] is not None else None,
            "meters": round(row["meters"]) if row["meters"] is not None else None,
        }
        for row in rows
    ]
    return {"total": total["n"], "items": items}


@app.get("/api/orders/{order_id}/track")
async def order_track(order_id: int):
    async with transaction() as conn:
        ctx = await orders.context(conn, order_id)
        found = await legs(conn, order_id)
        if not found:
            raise orders.NotFound("trajeto ainda não gravado")
        courier = (
            await one(conn, "SELECT name FROM couriers WHERE id = :id", id=ctx["courier_id"])
            if ctx["courier_id"]
            else None
        )
        timeline = await many(
            conn,
            "SELECT type, status, actor, at FROM order_events WHERE order_id = :id ORDER BY id",
            id=order_id,
        )
        alerts = await many(
            conn,
            "SELECT kind, courier_id, detail, opened_at, closed_at FROM alerts WHERE order_id = :id ORDER BY id",
            id=order_id,
        )
    return {
        "order_id": order_id,
        "status": ctx["status"],
        "store": {"id": ctx["store_id"], "name": ctx["store_name"], **orders.store_point(ctx)},
        "customer": orders.customer_point(ctx),
        "courier_id": ctx["courier_id"],
        "courier_name": courier["name"] if courier else None,
        "created_at": ctx["created_at"],
        "promised_at": ctx["promised_at"],
        "delivered_at": ctx["delivered_at"],
        "legs": found,
        "timeline": [dict(row) for row in timeline],
        "alerts": [{**dict(row), "detail": loads(row["detail"])} for row in alerts],
    }


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
