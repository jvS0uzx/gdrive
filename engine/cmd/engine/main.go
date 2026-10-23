package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
	"github.com/jvS0uzx/gdrive/engine/internal/route"
	"github.com/jvS0uzx/gdrive/engine/internal/server"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func healthcheck(addr string) int {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1" + addr + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	addr := flag.String("addr", env("ADDR", ":8080"), "endereço HTTP")
	cityPath := flag.String("city", env("CITY", "../cities/salvador/city.gob.gz"), "arquivo da cidade")
	check := flag.Bool("healthcheck", false, "consulta /healthz e sai com 0 ou 1")
	flag.Parse()
	if *check {
		os.Exit(healthcheck(*addr))
	}

	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	began := time.Now()
	c, err := city.Load(*cityPath)
	if err != nil {
		log.Error("cidade não carregou", "err", err)
		os.Exit(1)
	}
	srv, err := server.New(c, route.New(c), log)
	if err != nil {
		log.Error("servidor não montou", "err", err)
		os.Exit(1)
	}
	log.Info("cidade carregada", "cidade", c.Name, "nós", len(c.Nodes), "trechos", len(c.Streets), "em", time.Since(began).Round(time.Millisecond))

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("servidor caiu", "err", err)
			stop()
		}
	}()
	log.Info("ouvindo", "addr", *addr)
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdown); err != nil {
		log.Error("desligamento", "err", err)
	}
}
