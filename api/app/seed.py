from sqlalchemy import text

from app.db import one, run, transaction

KINDS = {"stores": "store", "courier_homes": "courier_home", "customers": "customer"}


async def seed_if_empty(engine) -> bool:
    async with transaction() as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(4242)"))
        if (await one(conn, "SELECT count(*) AS n FROM addresses"))["n"] > 0:
            return False
        data = await engine.addresses()
        for group, kind in KINDS.items():
            places = data.get(group) or []
            if not places:
                continue
            await run(
                conn,
                "INSERT INTO addresses (node_id, kind, lat, lon) SELECT node, :kind, lat, lon FROM "
                "unnest(CAST(:nodes AS integer[]), CAST(:lats AS float8[]), CAST(:lons AS float8[])) "
                "WITH ORDINALITY AS p(node, lat, lon, n) ORDER BY n",
                kind=kind,
                nodes=[p["node"] for p in places],
                lats=[p["lat"] for p in places],
                lons=[p["lon"] for p in places],
            )
            if kind == "store":
                await run(
                    conn,
                    "INSERT INTO stores (name, address_id) SELECT name, id FROM "
                    "(SELECT a.id, row_number() OVER (ORDER BY a.id) AS n FROM addresses a WHERE a.kind = 'store') a "
                    "JOIN unnest(CAST(:names AS text[])) WITH ORDINALITY AS p(name, n) USING (n)",
                    names=[p.get("name") or "Loja" for p in places],
                )
            if kind == "courier_home":
                await run(
                    conn,
                    "INSERT INTO couriers (name, home_address_id) SELECT 'Entregador ' || "
                    "row_number() OVER (ORDER BY id), id FROM addresses WHERE kind = 'courier_home' ORDER BY id",
                )
        return True
