FROM golang:1.27-alpine AS build
WORKDIR /src
COPY engine/go.mod ./
COPY engine/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/engine ./cmd/engine && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sim ./cmd/sim && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/load ./cmd/load

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/engine /engine
COPY --from=build /out/sim /sim
COPY --from=build /out/load /load
COPY cities/salvador/city.gob.gz /data/city.gob.gz
ENV CITY=/data/city.gob.gz ADDR=:8080
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD ["/engine", "-healthcheck"]
ENTRYPOINT ["/engine"]
