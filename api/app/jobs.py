import json
import logging
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import loads, many, run, transaction

log = logging.getLogger("gdrive.jobs")

Handler = Callable[..., Awaitable[object]]


async def schedule(conn: AsyncConnection, kind: str, delay: float = 0, **payload) -> None:
    await run(
        conn,
        "INSERT INTO jobs (kind, payload, run_at) VALUES "
        "(:kind, CAST(:payload AS jsonb), now() + make_interval(secs => :delay))",
        kind=kind,
        payload=json.dumps(payload),
        delay=float(delay),
    )


async def run_due(handlers: dict[str, Handler], limit: int = 10) -> int:
    async with transaction() as conn:
        rows = await many(
            conn,
            "SELECT id, kind, payload FROM jobs WHERE done_at IS NULL AND run_at <= now() "
            "ORDER BY run_at, id LIMIT :limit FOR UPDATE SKIP LOCKED",
            limit=limit,
        )
        for row in rows:
            try:
                async with conn.begin_nested():
                    await handlers[row["kind"]](conn, **loads(row["payload"]))
                await run(
                    conn,
                    "UPDATE jobs SET done_at = now(), attempts = attempts + 1 WHERE id = :id",
                    id=row["id"],
                )
            except Exception as exc:
                log.exception("job %s (%s) falhou", row["id"], row["kind"])
                await run(
                    conn,
                    "UPDATE jobs SET attempts = attempts + 1, last_error = :error, "
                    "run_at = now() + make_interval(secs => least(60, power(2, attempts + 1))), "
                    "done_at = CASE WHEN attempts + 1 >= 5 THEN now() END WHERE id = :id",
                    id=row["id"],
                    error=repr(exc)[:500],
                )
        return len(rows)
