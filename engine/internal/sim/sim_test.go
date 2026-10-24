package sim

import (
	"math"
	"testing"

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
