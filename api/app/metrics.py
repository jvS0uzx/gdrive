import time

from prometheus_client import Counter, Histogram, disable_created_metrics

# A série _created de cada rótulo não entra em painel nenhum e só aumenta a coleta.
disable_created_metrics()

HTTP_SECONDS = Histogram(
    "gdrive_http_request_duration_seconds",
    "Duração das requisições HTTP da api, pela rota declarada",
    ["method", "route", "status"],
)
JOBS = Counter("gdrive_jobs_total", "Jobs executados pelo worker", ["kind", "result"])
DISPATCH_SECONDS = Histogram(
    "gdrive_dispatch_seconds", "Duração de uma rodada de despacho de um pedido", ["result"]
)
OUTBOX_LAG = Histogram(
    "gdrive_outbox_lag_seconds",
    "Atraso entre gravar o evento na outbox e publicá-lo no Redis",
    ["topic"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)


class HttpMetrics:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] == "/metrics":
            await self.app(scope, receive, send)
            return
        # Exceção que escapa do app vira 500 no ServerErrorMiddleware, que fica por fora deste.
        status = 500

        async def capture(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        start = time.perf_counter()
        try:
            await self.app(scope, receive, capture)
        finally:
            # A rota declarada, e não o path, para que cada id não vire uma série nova.
            route = scope.get("route")
            HTTP_SECONDS.labels(scope["method"], route.path if route else "sem_rota", str(status)).observe(
                time.perf_counter() - start
            )
