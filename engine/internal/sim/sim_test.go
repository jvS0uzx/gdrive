package sim

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jvS0uzx/gdrive/engine/internal/live"
)

func TestPosicaoAoLongoDaRota(t *testing.T) {
	p := Path{
		Coords:     [][2]float64{{-38.50, -12.97}, {-38.49, -12.97}, {-38.49, -12.96}},
		Cumulative: []float64{0, 100, 300},
	}
	cases := []struct {
		elapsed  float64
		lat, lon float64
	}{
		{0, -12.97, -38.50},
		{50, -12.97, -38.495},
		{100, -12.97, -38.49},
		{200, -12.965, -38.49},
		{999, -12.96, -38.49},
	}
	for _, tc := range cases {
		got := PositionAt(p, tc.elapsed)
		if math.Abs(got.Lat-tc.lat) > 1e-9 || math.Abs(got.Lon-tc.lon) > 1e-9 {
			t.Fatalf("em %.0f s: %+v, esperado (%f, %f)", tc.elapsed, got, tc.lat, tc.lon)
		}
	}
}

func TestEntregadorAndaNaVelocidadeDaSimulacao(t *testing.T) {
	c := &courier{id: 1, pos: live.Point{Lat: -12.97, Lon: -38.50}}
	if p := c.step(10); p.Lat != -12.97 {
		t.Fatalf("parado sem rota deveria ficar onde está: %+v", p)
	}
	c.follow(&Path{Coords: [][2]float64{{-38.50, -12.97}, {-38.48, -12.97}}, Cumulative: []float64{0, 100}})
	c.step(25)
	if p := c.step(25); math.Abs(p.Lon-(-38.49)) > 1e-9 {
		t.Fatalf("depois de 50 s de 100 deveria estar no meio: %+v", p)
	}
	c.step(500)
	if p := c.position(); p.Lon != -38.48 {
		t.Fatalf("passou do fim da rota: %+v", p)
	}
	c.stop()
	if p := c.step(10); p.Lon != -38.48 {
		t.Fatalf("parado deveria ficar no último ponto: %+v", p)
	}
}

func TestRotaDeUmPontoSo(t *testing.T) {
	got := PositionAt(Path{Coords: [][2]float64{{-38.5, -12.9}}, Cumulative: []float64{0}}, 10)
	if got.Lat != -12.9 || got.Lon != -38.5 {
		t.Fatalf("%+v", got)
	}
}

func serverWith(t *testing.T, codes ...int) (*Sim, *int) {
	t.Helper()
	calls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code := codes[min(calls, len(codes)-1)]
		calls++
		w.WriteHeader(code)
	}))
	t.Cleanup(ts.Close)
	s := New(Config{APIURL: ts.URL, Attempts: 4, RetryDelay: time.Millisecond}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return s, &calls
}

func TestAcaoTentaDeNovoQuandoAApiCai(t *testing.T) {
	s, calls := serverWith(t, 503, 502, 200)
	s.post(context.Background(), "/api/orders/1/deliver", nil)
	if *calls != 3 {
		t.Fatalf("esperado 3 chamadas até o 200, foram %d", *calls)
	}
}

func TestConflitoNaoGanhaNovaTentativa(t *testing.T) {
	s, calls := serverWith(t, 409)
	s.post(context.Background(), "/api/orders/1/pickup", nil)
	if *calls != 1 {
		t.Fatalf("409 é resposta final, foram %d chamadas", *calls)
	}
}

func TestDesisteDepoisDoLimiteDeTentativas(t *testing.T) {
	s, calls := serverWith(t, 500)
	s.post(context.Background(), "/api/orders/1/deliver", nil)
	if *calls != 4 {
		t.Fatalf("esperado parar em 4 tentativas, foram %d", *calls)
	}
}

func TestEntregadorParadoNaoAndaAteOPrazo(t *testing.T) {
	c := &courier{id: 1, pos: live.Point{Lat: -12.97, Lon: -38.50}}
	c.follow(&Path{Coords: [][2]float64{{-38.50, -12.97}, {-38.48, -12.97}}, Cumulative: []float64{0, 100}})
	c.frozen = time.Now().Add(time.Hour)
	if p := c.step(50); p.Lon != -38.50 {
		t.Fatalf("parado andou: %+v", p)
	}
	c.frozen = time.Time{}
	if p := c.step(50); math.Abs(p.Lon-(-38.49)) > 1e-9 {
		t.Fatalf("depois de liberado deveria seguir do mesmo ponto: %+v", p)
	}
}

func TestDesvioPassaLongeDaLinhaReta(t *testing.T) {
	from, to := live.Point{Lat: -12.97, Lon: -38.50}, live.Point{Lat: -12.99, Lon: -38.50}
	ways := Waypoints(from, to, 700)
	mid := live.Point{Lat: -12.98, Lon: -38.50}
	for _, w := range ways {
		if d := live.Distance(mid, w); d < 690 || d > 710 {
			t.Fatalf("ponto de desvio a %.0f m do meio do caminho: %+v", d, w)
		}
		if math.Abs(w.Lat-mid.Lat) > 1e-6 {
			t.Fatalf("desvio deveria ser perpendicular ao trajeto norte-sul: %+v", w)
		}
	}
	if (ways[0].Lon-mid.Lon)*(ways[1].Lon-mid.Lon) >= 0 {
		t.Fatalf("os dois pontos deveriam ficar em lados opostos: %+v", ways)
	}
}

func TestJuntaDuasRotasSemRepetirOPontoDoMeio(t *testing.T) {
	a := &Path{Coords: [][2]float64{{0, 0}, {1, 0}}, Cumulative: []float64{0, 10}}
	b := &Path{Coords: [][2]float64{{1, 0}, {1, 1}, {2, 1}}, Cumulative: []float64{0, 5, 15}}
	got := Join(a, b)
	if len(got.Coords) != 4 || got.Coords[2] != [2]float64{1, 1} {
		t.Fatalf("pontos: %v", got.Coords)
	}
	if want := []float64{0, 10, 15, 25}; fmt.Sprint(got.Cumulative) != fmt.Sprint(want) {
		t.Fatalf("tempos acumulados %v, esperado %v", got.Cumulative, want)
	}
	if len(a.Coords) != 2 {
		t.Fatal("a rota original foi alterada")
	}
}
