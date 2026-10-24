import json
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.config import settings

engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=20, pool_pre_ping=True)


@asynccontextmanager
async def transaction():
    async with engine.begin() as conn:
        yield conn


async def one(conn: AsyncConnection, sql: str, **params: Any):
    result = await conn.execute(text(sql), params)
    return result.mappings().one_or_none()


async def many(conn: AsyncConnection, sql: str, **params: Any):
    result = await conn.execute(text(sql), params)
    return result.mappings().all()


async def run(conn: AsyncConnection, sql: str, **params: Any) -> int:
    result = await conn.execute(text(sql), params)
    return result.rowcount


def loads(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value
