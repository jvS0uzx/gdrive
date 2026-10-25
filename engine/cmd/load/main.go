package main

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
	"github.com/jvS0uzx/gdrive/engine/internal/load"
	"github.com/jvS0uzx/gdrive/engine/internal/route"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func number(key string, fallback float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(key), 64); err == nil {
		return v
	}
	return fallback
}

func duration(key string, fallback time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(key)); err == nil {
		return v
	}
	return fallback
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	cfg := load.Config{
		Target:    env("TARGET", "ws://web"),
		Couriers:  int(number("COURIERS", 1000)),
		FirstID:   int64(number("FIRST_ID", 1_000_000)),
		Tick:      duration("TICK", 2*time.Second),
		Speed:     number("SPEED", 8),
		Busy:      number("BUSY_RATIO", 0.4),
		RampStep:  int(number("RAMP_STEP", 1000)),
		RampEvery: duration("RAMP_EVERY", 10*time.Second),
		Routes:    int(number("ROUTES", 400)),
		Seed:      uint64(number("SEED", 7)),
	}
	opts, err := redis.ParseURL(env("REDIS_URL", "redis://redis:6379/0"))
	if err != nil {
		log.Error("REDIS_URL inválida", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opts)

	began := time.Now()
	c, err := city.Load(env("CITY", "/data/city.gob.gz"))
	if err != nil {
		log.Error("cidade não carregou", "err", err)
		os.Exit(1)
	}
	pool := load.Routes(c, route.New(c), cfg.Routes, rand.New(rand.NewPCG(cfg.Seed, cfg.Seed+1)))
	log.Info("rotas da carga", "rotas", len(pool), "em", time.Since(began).Round(time.Millisecond))

	go func() {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", promhttp.Handler())
		srv := &http.Server{Addr: env("METRICS_ADDR", ":9101"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("métricas do gerador", "err", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if d := duration("DURATION", 0); d > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d)
		defer cancel()
	}
	l := load.New(cfg, pool, rdb, log)
	log.Info("carga começou", "alvo", cfg.Target, "entregadores", cfg.Couriers, "em_corrida", cfg.Busy)
	if err := l.Run(ctx); err != nil {
		log.Error("carga parou", "err", err)
		os.Exit(1)
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := l.Cleanup(cleanup); err != nil {
		log.Error("limpeza do redis", "err", err)
		os.Exit(1)
	}
	positions, failed := l.Totals()
	log.Info("carga terminou e o redis foi limpo", "posições", positions, "falhas", failed)
	if limit := int64(number("MAX_ERRORS", -1)); limit >= 0 && failed > limit {
		log.Error("falhas acima do limite", "falhas", failed, "limite", limit)
		os.Exit(1)
	}
	if minimum := int64(number("MIN_POSITIONS", 0)); positions < minimum {
		log.Error("posições abaixo do mínimo", "posições", positions, "mínimo", minimum)
		os.Exit(1)
	}
}
