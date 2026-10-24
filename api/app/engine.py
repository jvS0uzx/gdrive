import httpx


class Engine:
    def __init__(self, base_url: str):
        self.http = httpx.AsyncClient(base_url=base_url, timeout=10)

    async def route_seconds(self, origin: dict, destination: dict) -> float:
        response = await self.http.post("/route", json={"from": origin, "to": destination})
        response.raise_for_status()
        return response.json()["seconds"]

    async def etas(self, lat: float, lon: float, couriers: list[int]) -> list[tuple[int, float]]:
        response = await self.http.post("/eta", json={"to": {"lat": lat, "lon": lon}, "couriers": couriers})
        response.raise_for_status()
        return [(item["courier_id"], item["seconds"]) for item in response.json()["etas"]]

    async def addresses(self) -> dict:
        response = await self.http.get("/city/addresses")
        response.raise_for_status()
        return response.json()

    async def close(self) -> None:
        await self.http.aclose()
