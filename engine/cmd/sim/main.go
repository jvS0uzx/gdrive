package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/jvS0uzx/gdrive/engine/internal/sim"
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
	opts, err := redis.ParseURL(env("REDIS_URL", "redis://localhost:6379/0"))
	if err != nil {
		log.Error("REDIS_URL inválida", "err", err)
		os.Exit(1)
	}
	cfg := sim.Config{
		APIURL:      env("API_URL", "http://localhost:8085"),
		EngineURL:   env("ENGINE_URL", "http://localhost:8086"),
		Couriers:    int(number("COURIERS", 60)),
		OrderEvery:  duration("ORDER_EVERY", 5*time.Second),
		Speed:       number("SPEED", 8),
		Tick:        duration("TICK", time.Second),
		AcceptRate:  number("ACCEPT_RATE", 0.85),
		DeclineRate: number("DECLINE_RATE", 0.1),
		StoreRadius: number("STORE_RADIUS_M", 4000),
		Seed:        uint64(number("SEED", 42)),
		Attempts:    int(number("ATTEMPTS", 6)),
		RetryDelay:  duration("RETRY_DELAY", time.Second),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	s := sim.New(cfg, redis.NewClient(opts), log)
	if err := s.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("simulação parou", "err", err)
		os.Exit(1)
	}
}
