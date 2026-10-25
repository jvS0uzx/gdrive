package load

import (
	"context"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/jvS0uzx/gdrive/engine/internal/live"
	"github.com/jvS0uzx/gdrive/engine/internal/sim"
)

func loop() sim.Path {
	return sim.Path{
		Coords:     [][2]float64{{-38.50, -12.97}, {-38.49, -12.97}, {-38.50, -12.97}},
		Cumulative: []float64{0, 60, 120},
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestEntregadorDaVoltasNaRota(t *testing.T) {
	c := &courier{path: loop()}
	if p := c.step(30); !near(p.Lon, -38.495) {
		t.Fatalf("meio da ida: %v", p)
	}
	if p := c.step(120); !near(p.Lon, -38.495) {
		t.Fatalf("uma volta inteira depois deveria estar no mesmo ponto: %v", p)
	}
	if at := c.target(); !near(at.Lon, -38.49) {
		t.Fatalf("alvo no fim da ida: %v", at)
	}
}

func TestCargaChegaAoEngineEALimpezaApagaORedis(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := live.New(rdb, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	hub.Run(ctx)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/courier", hub.ServeCourier)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	cfg := Config{
		Target:    "ws" + strings.TrimPrefix(ts.URL, "http"),
		Couriers:  20,
		FirstID:   1_000_000,
		Tick:      50 * time.Millisecond,
		Speed:     8,
		Busy:      0.5,
		RampStep:  10,
		RampEvery: 50 * time.Millisecond,
		Seed:      3,
	}
	l := New(cfg, []sim.Path{loop()}, rdb, quiet)
	run, stop := context.WithTimeout(ctx, 800*time.Millisecond)
	defer stop()
	if err := l.Run(run); err != nil {
		t.Fatal(err)
	}

	if sent, failed := l.Totals(); sent == 0 || failed != 0 {
		t.Fatalf("posições escritas %d, falhas %d", sent, failed)
	}
	positions, err := rdb.ZCard(ctx, live.GeoKey).Result()
	if err != nil || positions != 20 {
		t.Fatalf("entregadores no geo:couriers: %d, %v", positions, err)
	}
	busy := 0
	for _, c := range l.couriers {
		if c.busy {
			busy++
			if n, _ := rdb.LLen(ctx, live.TrackKey(orderOffset+c.id, "cliente")).Result(); n == 0 {
				t.Fatalf("entregador %d em corrida sem rastro", c.id)
			}
		}
	}
	if busy == 0 || busy == 20 {
		t.Fatalf("fração em corrida não foi sorteada: %d de 20", busy)
	}

	if err := l.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := rdb.ZCard(ctx, live.GeoKey).Result(); n != 0 {
		t.Fatalf("geo:couriers depois da limpeza: %d", n)
	}
	for _, key := range mr.Keys() {
		for _, prefix := range []string{"courier:", "target:", "plan:", "track:"} {
			if strings.HasPrefix(key, prefix) {
				t.Fatalf("chave da carga sobrou: %s", key)
			}
		}
	}
}
