from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://postgres:gdrive@localhost:55432/gdrive_test"
    redis_url: str = "redis://localhost:56379/0"
    engine_url: str = "http://localhost:8086"
    seed_on_start: bool = True
    offer_seconds: int = 30
    store_timeout_seconds: int = 300
    dispatch_retry_seconds: int = 20
    radius_steps_m: list[int] = [2000, 4000, 6000]
    unassigned_alert_seconds: int = 180
    promise_margin_seconds: int = 300


settings = Settings()
