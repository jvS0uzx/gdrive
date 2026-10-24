from sqlalchemy.ext.asyncio import AsyncConnection

from app.config import settings
from app.db import one, run
from app.events import emit
from app.jobs import schedule


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


TRANSITIONS = {
    "aguardando_loja": {"em_preparo", "recusado", "cancelado"},
    "em_preparo": {"a_caminho_da_loja", "cancelado"},
    "a_caminho_da_loja": {"na_loja", "em_preparo", "cancelado"},
    "na_loja": {"em_rota", "em_preparo", "cancelado"},
    "em_rota": {"no_cliente"},
    "no_cliente": {"entregue"},
}

ACTIVE = ("a_caminho_da_loja", "na_loja", "em_rota", "no_cliente")
CANCELLABLE = ("aguardando_loja", "em_preparo", "a_caminho_da_loja", "na_loja")


async def transition(conn: AsyncConnection, order_id: int, expected: str | tuple[str, ...], new: str, **sets):
    expected = (expected,) if isinstance(expected, str) else expected
    for state in expected:
        if new not in TRANSITIONS.get(state, set()):
            raise ValueError(f"transição fora da tabela: {state} → {new}")
    assignments = "".join(f", {column} = :{column}" for column in sets)
    row = await one(
        conn,
        f"UPDATE orders SET status = :new, version = version + 1, updated_at = now(){assignments} "
        "WHERE id = :id AND status = ANY(:expected) RETURNING *",
        new=new,
        id=order_id,
        expected=list(expected),
        **sets,
    )
    if row is None:
        current = await one(conn, "SELECT status FROM orders WHERE id = :id", id=order_id)
        if current is None:
            raise NotFound("pedido não existe")
        raise Conflict(f"pedido está em {current['status']}")
    return row


async def context(conn: AsyncConnection, order_id: int):
    row = await one(
        conn,
        "SELECT o.*, s.name AS store_name, sa.lat AS store_lat, sa.lon AS store_lon, "
        "ca.lat AS customer_lat, ca.lon AS customer_lon "
        "FROM orders o JOIN stores s ON s.id = o.store_id JOIN addresses sa ON sa.id = s.address_id "
        "JOIN addresses ca ON ca.id = o.address_id WHERE o.id = :id",
        id=order_id,
    )
    if row is None:
        raise NotFound("pedido não existe")
    return row


def store_point(ctx) -> dict:
    return {"lat": ctx["store_lat"], "lon": ctx["store_lon"]}


def customer_point(ctx) -> dict:
    return {"lat": ctx["customer_lat"], "lon": ctx["customer_lon"]}


async def endpoints(conn: AsyncConnection, store_id: int, address_id: int):
    store = await one(
        conn,
        "SELECT s.id, s.name, s.default_prep_minutes, a.lat, a.lon FROM stores s "
        "JOIN addresses a ON a.id = s.address_id WHERE s.id = :id",
        id=store_id,
    )
    if store is None:
        raise NotFound("loja não existe")
    customer = await one(
        conn, "SELECT id, lat, lon FROM addresses WHERE id = :id AND kind = 'customer'", id=address_id
    )
    if customer is None:
        raise NotFound("endereço de cliente não existe")
    return store, customer


async def create(conn: AsyncConnection, store, customer, travel_seconds: float) -> int:
    promise = store["default_prep_minutes"] * 60 + travel_seconds + settings.promise_margin_seconds
    order = await one(
        conn,
        "INSERT INTO orders (store_id, address_id, status, promised_at) VALUES "
        "(:store, :address, 'aguardando_loja', now() + make_interval(secs => :promise)) RETURNING id",
        store=store["id"],
        address=customer["id"],
        promise=float(promise),
    )
    await emit(
        conn,
        order["id"],
        "pedido_criado",
        "cliente",
        store={"lat": store["lat"], "lon": store["lon"]},
        customer={"lat": customer["lat"], "lon": customer["lon"]},
        store_name=store["name"],
    )
    await schedule(conn, "store_timeout", delay=settings.store_timeout_seconds, order_id=order["id"])
    return order["id"]


async def owned_by_store(conn: AsyncConnection, store_id: int, order_id: int) -> None:
    row = await one(conn, "SELECT store_id FROM orders WHERE id = :id", id=order_id)
    if row is None or row["store_id"] != store_id:
        raise NotFound("pedido não é dessa loja")


async def accept_by_store(conn: AsyncConnection, store_id: int, order_id: int, prep_minutes: int) -> None:
    await owned_by_store(conn, store_id, order_id)
    await transition(
        conn,
        order_id,
        "aguardando_loja",
        "em_preparo",
        prep_minutes=prep_minutes,
        dispatch_radius_m=settings.radius_steps_m[0],
    )
    await run(conn, "UPDATE orders SET dispatch_started_at = now() WHERE id = :id", id=order_id)
    await emit(conn, order_id, "pedido_aceito_pela_loja", "loja", prep_minutes=prep_minutes)
    await schedule(conn, "dispatch", order_id=order_id)


async def reject_by_store(conn: AsyncConnection, store_id: int, order_id: int) -> None:
    await owned_by_store(conn, store_id, order_id)
    await transition(conn, order_id, "aguardando_loja", "recusado")
    await emit(conn, order_id, "pedido_recusado_pela_loja", "loja")


async def store_timeout(conn: AsyncConnection, order_id: int) -> None:
    try:
        await transition(conn, order_id, "aguardando_loja", "recusado")
    except Conflict:
        return
    await emit(conn, order_id, "pedido_expirado_na_loja", "sistema")


async def ready(conn: AsyncConnection, store_id: int, order_id: int) -> None:
    await owned_by_store(conn, store_id, order_id)
    changed = await run(
        conn,
        "UPDATE orders SET ready_at = now(), version = version + 1, updated_at = now() "
        "WHERE id = :id AND ready_at IS NULL AND status IN ('em_preparo', 'a_caminho_da_loja', 'na_loja')",
        id=order_id,
    )
    if not changed:
        raise Conflict("pedido já estava pronto ou não está em preparo")
    await emit(conn, order_id, "pedido_pronto", "loja")


async def set_courier_status(
    conn: AsyncConnection, courier_id: int, expected: tuple[str, ...], new: str
) -> None:
    changed = await run(
        conn,
        "UPDATE couriers SET status = :new WHERE id = :id AND status = ANY(:expected)",
        id=courier_id,
        new=new,
        expected=list(expected),
    )
    if not changed:
        current = await one(conn, "SELECT status FROM couriers WHERE id = :id", id=courier_id)
        if current is None:
            raise NotFound("entregador não existe")
        raise Conflict(f"entregador está {current['status']}")


async def go_online(conn: AsyncConnection, courier_id: int) -> None:
    await set_courier_status(conn, courier_id, ("offline", "livre"), "livre")


async def go_offline(conn: AsyncConnection, courier_id: int) -> None:
    await set_courier_status(conn, courier_id, ("offline", "livre"), "offline")


async def pending_offer(conn: AsyncConnection, offer_id: int, courier_id: int | None):
    offer = await one(conn, "SELECT id, order_id, courier_id, status FROM offers WHERE id = :id", id=offer_id)
    if offer is None:
        raise NotFound("oferta não existe")
    if courier_id is not None and offer["courier_id"] != courier_id:
        raise NotFound("oferta não é desse entregador")
    return offer


async def accept_offer(conn: AsyncConnection, offer_id: int, courier_id: int | None = None) -> int:
    offer = await pending_offer(conn, offer_id, courier_id)
    accepted = await one(
        conn,
        "UPDATE offers SET status = 'aceita' WHERE id = :id AND status = 'pendente' AND expires_at > now() "
        "RETURNING order_id, courier_id",
        id=offer_id,
    )
    if accepted is None:
        raise Conflict("oferta expirada ou já respondida")
    await set_courier_status(conn, offer["courier_id"], ("livre",), "ocupado")
    await transition(
        conn, offer["order_id"], "em_preparo", "a_caminho_da_loja", courier_id=offer["courier_id"]
    )
    ctx = await context(conn, offer["order_id"])
    await emit(
        conn,
        offer["order_id"],
        "entregador_atribuido",
        "entregador",
        offer_id=offer_id,
        store=store_point(ctx),
        customer=customer_point(ctx),
    )
    return offer["order_id"]


async def decline_offer(conn: AsyncConnection, offer_id: int, courier_id: int | None = None) -> None:
    offer = await pending_offer(conn, offer_id, courier_id)
    changed = await run(
        conn, "UPDATE offers SET status = 'recusada' WHERE id = :id AND status = 'pendente'", id=offer_id
    )
    if not changed:
        raise Conflict("oferta já respondida")
    await emit(
        conn,
        offer["order_id"],
        "oferta_recusada",
        "entregador",
        offer_id=offer_id,
        courier_id=offer["courier_id"],
    )
    await schedule(conn, "dispatch", order_id=offer["order_id"])


async def expire_offer(conn: AsyncConnection, offer_id: int) -> None:
    offer = await one(
        conn,
        "UPDATE offers SET status = 'expirada' WHERE id = :id AND status = 'pendente' RETURNING order_id, courier_id",
        id=offer_id,
    )
    if offer is None:
        return
    await emit(
        conn,
        offer["order_id"],
        "oferta_expirada",
        "sistema",
        offer_id=offer_id,
        courier_id=offer["courier_id"],
    )
    await schedule(conn, "dispatch", order_id=offer["order_id"])


async def assigned_to(conn: AsyncConnection, order_id: int, courier_id: int) -> None:
    row = await one(conn, "SELECT courier_id FROM orders WHERE id = :id", id=order_id)
    if row is None:
        raise NotFound("pedido não existe")
    if row["courier_id"] != courier_id:
        raise Conflict("pedido não está com esse entregador")


async def pickup(conn: AsyncConnection, order_id: int, courier_id: int) -> None:
    await assigned_to(conn, order_id, courier_id)
    row = await one(conn, "SELECT ready_at FROM orders WHERE id = :id", id=order_id)
    if row["ready_at"] is None:
        raise Conflict("pedido ainda não está pronto")
    await transition(conn, order_id, "na_loja", "em_rota")
    ctx = await context(conn, order_id)
    await emit(conn, order_id, "pedido_coletado", "entregador", customer=customer_point(ctx))


async def deliver(conn: AsyncConnection, order_id: int, courier_id: int) -> None:
    await assigned_to(conn, order_id, courier_id)
    await transition(conn, order_id, "no_cliente", "entregue")
    await set_courier_status(conn, courier_id, ("ocupado",), "livre")
    await emit(conn, order_id, "pedido_entregue", "entregador")


async def cancel(conn: AsyncConnection, order_id: int) -> None:
    row = await transition(conn, order_id, CANCELLABLE, "cancelado")
    await run(
        conn,
        "UPDATE offers SET status = 'expirada' WHERE order_id = :id AND status = 'pendente'",
        id=order_id,
    )
    if row["courier_id"] is not None:
        await run(
            conn,
            "UPDATE couriers SET status = 'livre' WHERE id = :id AND status = 'ocupado'",
            id=row["courier_id"],
        )
    await emit(conn, order_id, "pedido_cancelado", "cliente")


ARRIVALS = {
    "loja": ("a_caminho_da_loja", "na_loja", "entregador_chegou_na_loja"),
    "cliente": ("em_rota", "no_cliente", "entregador_chegou_no_cliente"),
}


async def arrived(conn: AsyncConnection, order_id: int, phase: str) -> None:
    expected, new, kind = ARRIVALS[phase]
    await transition(conn, order_id, expected, new)
    await emit(conn, order_id, kind, "rastreio")
