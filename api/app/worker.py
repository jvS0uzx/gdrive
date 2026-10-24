import asyncio
import logging
import os
import signal
import socket

from redis.asyncio import Redis

from app import orders
from app.config import settings
from app.dispatch import dispatch
from app.engine import Engine
from app.history import save_track
from app.jobs import run_due
from app.monitor import check_late, watch_signal
from app.outbox import relay_once
from app.tracking import consume_once, ensure_group, reclaim_once

log = logging.getLogger("gdrive.worker")


def handlers(redis: Redis, engine: Engine) -> dict:
    async def run_dispatch(conn, order_id: int):
        await dispatch(conn, order_id, redis, engine)

    return {
        "dispatch": run_dispatch,
        "offer_timeout": lambda conn, offer_id: orders.expire_offer(conn, offer_id),
        "store_timeout": lambda conn, order_id: orders.store_timeout(conn, order_id),
        "late_check": check_late,
        "save_track": lambda conn, order_id: save_track(conn, redis, order_id),
    }


async def loop(name: str, step, idle: float, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            done = await step()
        except Exception:
            log.exception("%s falhou", name)
            done = 0
        if not done:
            try:
                await asyncio.wait_for(stop.wait(), timeout=idle)
            except TimeoutError:
                pass


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    engine = Engine(settings.engine_url)
    consumer = f"{socket.gethostname()}-{os.getpid()}"
    await ensure_group(redis)
    jobs = handlers(redis, engine)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    log.info("worker %s no ar", consumer)
    await asyncio.gather(
        loop("jobs", lambda: run_due(jobs), 0.2, stop),
        loop("outbox", lambda: relay_once(redis), 0.1, stop),
        loop("rastreio", lambda: consume_once(redis, consumer, block_ms=1000), 0, stop),
        loop("rastreio pendente", lambda: reclaim_once(redis, consumer), 15, stop),
        loop("sinal", lambda: watch_signal(redis), settings.signal_check_seconds, stop),
    )
    await engine.close()
    await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
