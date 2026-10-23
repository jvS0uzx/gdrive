package route

import (
	"math"
	"math/rand/v2"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"testing"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
)

var (
	salvadorOnce  sync.Once
	salvadorCity  *city.City
	salvadorGraph *Graph
	salvadorErr   error
)

func salvador(t testing.TB) (*city.City, *Graph) {
	t.Helper()
	salvadorOnce.Do(func() {
		_, file, _, _ := runtime.Caller(0)
		salvadorCity, salvadorErr = city.Load(filepath.Join(filepath.Dir(file), "..", "..", "..", "cities", "salvador", "city.gob.gz"))
		if salvadorErr == nil {
			salvadorGraph = New(salvadorCity)
		}
	})
	if salvadorErr != nil {
		t.Fatal(salvadorErr)
	}
	return salvadorCity, salvadorGraph
}

func randomCity(seed uint64, n int) *city.City {
	rng := rand.New(rand.NewPCG(seed, 99))
	c := &city.City{OriginLat: -12.97, OriginLon: -38.48}
	for range n {
		c.Nodes = append(c.Nodes, city.Node{X: rng.Float64() * 3000, Y: rng.Float64() * 3000})
	}
	type pair struct{ a, b int32 }
	seen := map[pair]bool{}
	for i := range c.Nodes {
		order := make([]int, n)
		for j := range order {
			order[j] = j
		}
		slices.SortFunc(order, func(a, b int) int {
			da, db := city.Distance(c.Nodes[i], c.Nodes[a]), city.Distance(c.Nodes[i], c.Nodes[b])
			switch {
			case da < db:
				return -1
			case da > db:
				return 1
			}
			return 0
		})
		for _, j := range order[1:4] {
			k := pair{int32(min(i, j)), int32(max(i, j))}
			if seen[k] {
				continue
			}
			seen[k] = true
			class := city.Classes[rng.IntN(len(city.Classes))]
			c.Streets = append(c.Streets, city.Street{
				From:     int32(i),
				To:       int32(j),
				Meters:   city.Distance(c.Nodes[i], c.Nodes[j]),
				SpeedKMH: class.DefaultKMH(),
				Class:    class,
				OneWay:   rng.Float64() < 0.3,
			})
		}
	}
	return c
}

func dijkstraFrom(g *Graph, from int32, factor float64) []float64 {
	dist := make([]float64, g.Len())
	for i := range dist {
		dist[i] = math.Inf(1)
	}
	dist[from] = 0
	pq := queue{{from, 0}}
	for len(pq) > 0 {
		it := pq.pop()
		v := it.node
		if it.priority > dist[v] {
			continue
		}
		for k := g.fwd.start[v]; k < g.fwd.start[v+1]; k++ {
			w := g.fwd.to[k]
			if d := dist[v] + g.fwd.sec[k]*factor; d < dist[w] {
				dist[w] = d
				pq.push(item{w, d})
			}
		}
	}
	return dist
}

func sameCost(a, b float64) bool {
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(a, b))
}

func TestAEstrelaDaOMesmoCustoQueDijkstraEm1000Grafos(t *testing.T) {
	graphs := 1000
	if testing.Short() {
		graphs = 100
	}
	for seed := range uint64(graphs) {
		g := New(randomCity(seed, 200))
		rng := rand.New(rand.NewPCG(seed, 1))
		from := int32(rng.IntN(g.Len()))
		factor := []float64{1, 1.4}[seed%2]
		all := dijkstraFrom(g, from, factor)
		for range 5 {
			to := int32(rng.IntN(g.Len()))
			p, ok := g.Shortest(from, to, factor)
			if ok == math.IsInf(all[to], 1) {
				t.Fatalf("grafo %d, %d→%d: A* achou rota %v, Dijkstra custo %v", seed, from, to, ok, all[to])
			}
			if ok && !sameCost(p.Seconds, all[to]) {
				t.Fatalf("grafo %d, %d→%d: A* deu %.6f s, Dijkstra %.6f s", seed, from, to, p.Seconds, all[to])
			}
		}
	}
}

func TestAEstrelaBateComDijkstraEmSalvador(t *testing.T) {
	_, g := salvador(t)
	rng := rand.New(rand.NewPCG(42, 1))
	origins := 40
	if testing.Short() {
		origins = 5
	}
	for range origins {
		from := int32(rng.IntN(g.Len()))
		all := dijkstraFrom(g, from, 1)
		for range 10 {
			to := int32(rng.IntN(g.Len()))
			p, ok := g.Shortest(from, to, 1)
			if !ok || !sameCost(p.Seconds, all[to]) {
				t.Fatalf("%d→%d: A* %.6f s (%v), Dijkstra %.6f s", from, to, p.Seconds, ok, all[to])
			}
		}
	}
}

func TestCaminhoEmSalvadorRespeitaMaoUnicaESomaCerto(t *testing.T) {
	c, g := salvador(t)
	rng := rand.New(rand.NewPCG(42, 2))
	for range 200 {
		from, to := int32(rng.IntN(g.Len())), int32(rng.IntN(g.Len()))
		p, ok := g.Shortest(from, to, 1)
		if !ok {
			t.Fatalf("sem rota de %d para %d numa malha fortemente conexa", from, to)
		}
		if p.Nodes[0] != from || p.Nodes[len(p.Nodes)-1] != to {
			t.Fatalf("caminho não liga %d a %d", from, to)
		}
		if len(p.Cumulative) != len(p.Nodes) || len(p.Streets) != len(p.Nodes)-1 {
			t.Fatalf("%d cruzamentos, %d tempos, %d trechos", len(p.Nodes), len(p.Cumulative), len(p.Streets))
		}
		var seconds, meters float64
		for i, si := range p.Streets {
			s := c.Streets[si]
			a, b := p.Nodes[i], p.Nodes[i+1]
			forward := s.From == a && s.To == b
			allowedBack := s.From == b && s.To == a && !s.OneWay
			if !forward && !allowedBack {
				t.Fatalf("caminho usa %d→%d pelo trecho %d (%d→%d, mão única %v)", a, b, si, s.From, s.To, s.OneWay)
			}
			seconds += s.Meters / s.SpeedMS()
			meters += s.Meters
			if !sameCost(p.Cumulative[i+1], seconds) {
				t.Fatalf("tempo acumulado no passo %d: %.3f, esperado %.3f", i+1, p.Cumulative[i+1], seconds)
			}
		}
		if !sameCost(p.Seconds, seconds) || !sameCost(p.Meters, meters) {
			t.Fatalf("totais %.3f s %.3f m, esperado %.3f s %.3f m", p.Seconds, p.Meters, seconds, meters)
		}
	}
}

func TestChuvaMultiplicaOTempoSemMudarARota(t *testing.T) {
	_, g := salvador(t)
	dry, _ := g.Shortest(10, 90000, 1)
	wet, _ := g.Shortest(10, 90000, 1.4)
	if !sameCost(wet.Seconds, dry.Seconds*1.4) || !sameCost(wet.Meters, dry.Meters) {
		t.Fatalf("seco %.1f s %.0f m, chuva %.1f s %.0f m", dry.Seconds, dry.Meters, wet.Seconds, wet.Meters)
	}
}

func TestUmParaMuitosBateComAEstrela(t *testing.T) {
	_, g := salvador(t)
	rng := rand.New(rand.NewPCG(42, 3))
	store := int32(rng.IntN(g.Len()))
	sources := make([]int32, 30)
	for i := range sources {
		sources[i] = int32(rng.IntN(g.Len()))
	}
	got := g.TimesTo(store, sources, 1)
	for i, s := range sources {
		p, _ := g.Shortest(s, store, 1)
		if !sameCost(got[i], p.Seconds) {
			t.Fatalf("entregador no nó %d: um-para-muitos %.3f s, A* %.3f s", s, got[i], p.Seconds)
		}
	}
}

func TestRotaParaOProprioCruzamentoEhVazia(t *testing.T) {
	g := New(randomCity(1, 50))
	p, ok := g.Shortest(5, 5, 1)
	if !ok || p.Seconds != 0 || len(p.Nodes) != 1 || len(p.Streets) != 0 {
		t.Fatalf("rota de 5 para 5: %+v %v", p, ok)
	}
}

func TestNearestAchaONoMaisProximo(t *testing.T) {
	c, g := salvador(t)
	rng := rand.New(rand.NewPCG(42, 4))
	b := c.Bounds()
	for range 100 {
		lon := b[0] + rng.Float64()*(b[2]-b[0])
		lat := b[1] + rng.Float64()*(b[3]-b[1])
		x, y := c.ToXY(lat, lon)
		got, gotDist := g.Nearest(x, y)
		bestDist := math.Inf(1)
		for _, n := range c.Nodes {
			bestDist = math.Min(bestDist, math.Hypot(n.X-x, n.Y-y))
		}
		if got < 0 || !sameCost(gotDist, bestDist) {
			t.Fatalf("(%f, %f): achou %d a %.1f m, o mais próximo está a %.1f m", lat, lon, got, gotDist, bestDist)
		}
	}
}

func BenchmarkRotaAtravessandoSalvador(b *testing.B) {
	_, g := salvador(b)
	rng := rand.New(rand.NewPCG(42, 5))
	pairs := make([][2]int32, 256)
	for i := range pairs {
		pairs[i] = [2]int32{int32(rng.IntN(g.Len())), int32(rng.IntN(g.Len()))}
	}
	b.ResetTimer()
	for i := range b.N {
		p := pairs[i%len(pairs)]
		g.Shortest(p[0], p[1], 1)
	}
}
