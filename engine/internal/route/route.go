package route

import (
	"math"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
)

const snapCell = 250.0

type cellKey struct {
	x, y int
}

type arcs struct {
	start      []int32
	to         []int32
	sec        []float64
	meters     []float64
	street     []int32
	expressway []bool
}

type Mode int

const (
	Fastest Mode = iota
	Shortest
	NoExpressway
)

type Graph struct {
	nodes    []city.Node
	fwd      arcs
	rev      arcs
	maxSpeed float64
	grid     map[cellKey][]int32
}

type Path struct {
	Nodes      []int32
	Streets    []int32
	Seconds    float64
	Meters     float64
	Cumulative []float64
}

func New(c *city.City) *Graph {
	g := &Graph{nodes: c.Nodes, grid: map[cellKey][]int32{}}
	n := len(c.Nodes)
	type arc struct {
		from, to    int32
		sec, meters float64
		street      int32
		expressway  bool
	}
	var all []arc
	for i, s := range c.Streets {
		speed := s.SpeedMS()
		g.maxSpeed = math.Max(g.maxSpeed, speed)
		fast := s.Class == city.ClassExpressway
		all = append(all, arc{s.From, s.To, s.Meters / speed, s.Meters, int32(i), fast})
		if !s.OneWay {
			all = append(all, arc{s.To, s.From, s.Meters / speed, s.Meters, int32(i), fast})
		}
	}
	build := func(reverse bool) arcs {
		a := arcs{start: make([]int32, n+1)}
		tail := func(x arc) int32 {
			if reverse {
				return x.to
			}
			return x.from
		}
		for _, x := range all {
			a.start[tail(x)+1]++
		}
		for i := 1; i <= n; i++ {
			a.start[i] += a.start[i-1]
		}
		a.to = make([]int32, len(all))
		a.sec = make([]float64, len(all))
		a.meters = make([]float64, len(all))
		a.street = make([]int32, len(all))
		a.expressway = make([]bool, len(all))
		fill := make([]int32, n)
		copy(fill, a.start[:n])
		for _, x := range all {
			t, h := x.from, x.to
			if reverse {
				t, h = h, t
			}
			k := fill[t]
			a.to[k], a.sec[k], a.meters[k], a.street[k], a.expressway[k] = h, x.sec, x.meters, x.street, x.expressway
			fill[t]++
		}
		return a
	}
	g.fwd = build(false)
	g.rev = build(true)
	for i, nd := range c.Nodes {
		k := keyOf(nd.X, nd.Y)
		g.grid[k] = append(g.grid[k], int32(i))
	}
	return g
}

func keyOf(x, y float64) cellKey {
	return cellKey{int(math.Floor(x / snapCell)), int(math.Floor(y / snapCell))}
}

func (g *Graph) Len() int {
	return len(g.nodes)
}

func (g *Graph) Nearest(x, y float64) (int32, float64) {
	best, bestDist := int32(-1), math.Inf(1)
	center := keyOf(x, y)
	for r := 0; r <= 40; r++ {
		if best >= 0 && bestDist <= float64(r-1)*snapCell {
			break
		}
		for dx := -r; dx <= r; dx++ {
			for dy := -r; dy <= r; dy++ {
				if max(abs(dx), abs(dy)) != r {
					continue
				}
				for _, v := range g.grid[cellKey{center.x + dx, center.y + dy}] {
					if d := math.Hypot(g.nodes[v].X-x, g.nodes[v].Y-y); d < bestDist {
						best, bestDist = v, d
					}
				}
			}
		}
	}
	return best, bestDist
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func (g *Graph) Shortest(from, to int32, factor float64) (Path, bool) {
	return g.ShortestBy(from, to, factor, Fastest)
}

func (g *Graph) ShortestBy(from, to int32, factor float64, mode Mode) (Path, bool) {
	n := len(g.nodes)
	dist := make([]float64, n)
	prevArc := make([]int32, n)
	closed := make([]bool, n)
	for i := range dist {
		dist[i] = math.Inf(1)
		prevArc[i] = -1
	}
	target := g.nodes[to]
	perMeter := factor / g.maxSpeed
	if mode == Shortest {
		perMeter = 1
	}
	h := func(v int32) float64 {
		return math.Hypot(g.nodes[v].X-target.X, g.nodes[v].Y-target.Y) * perMeter
	}
	cost := func(k int32) float64 {
		switch mode {
		case Shortest:
			return g.fwd.meters[k]
		case NoExpressway:
			if g.fwd.expressway[k] {
				return math.Inf(1)
			}
		}
		return g.fwd.sec[k] * factor
	}
	dist[from] = 0
	pq := queue{{from, h(from)}}
	for len(pq) > 0 {
		it := pq.pop()
		v := it.node
		if closed[v] {
			continue
		}
		closed[v] = true
		if v == to {
			break
		}
		for k := g.fwd.start[v]; k < g.fwd.start[v+1]; k++ {
			w := g.fwd.to[k]
			if closed[w] {
				continue
			}
			if d := dist[v] + cost(k); d < dist[w] {
				dist[w] = d
				prevArc[w] = k
				pq.push(item{w, d + h(w)})
			}
		}
	}
	if math.IsInf(dist[to], 1) {
		return Path{}, false
	}
	var arcsOnPath []int32
	for v := to; v != from; {
		k := prevArc[v]
		arcsOnPath = append(arcsOnPath, k)
		v = g.tailOf(k)
	}
	p := Path{Nodes: []int32{from}, Cumulative: []float64{0}}
	for i := len(arcsOnPath) - 1; i >= 0; i-- {
		k := arcsOnPath[i]
		p.Seconds += g.fwd.sec[k] * factor
		p.Meters += g.fwd.meters[k]
		p.Nodes = append(p.Nodes, g.fwd.to[k])
		p.Streets = append(p.Streets, g.fwd.street[k])
		p.Cumulative = append(p.Cumulative, p.Seconds)
	}
	return p, true
}

func (g *Graph) tailOf(k int32) int32 {
	lo, hi := 0, len(g.nodes)
	for lo < hi {
		mid := (lo + hi) / 2
		if g.fwd.start[mid+1] <= k {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return int32(lo)
}

func (g *Graph) TimesTo(target int32, sources []int32, factor float64) []float64 {
	n := len(g.nodes)
	dist := make([]float64, n)
	closed := make([]bool, n)
	for i := range dist {
		dist[i] = math.Inf(1)
	}
	wanted := make(map[int32]bool, len(sources))
	for _, s := range sources {
		wanted[s] = true
	}
	remaining := len(wanted)
	dist[target] = 0
	pq := queue{{target, 0}}
	for len(pq) > 0 && remaining > 0 {
		it := pq.pop()
		v := it.node
		if closed[v] {
			continue
		}
		closed[v] = true
		if wanted[v] {
			remaining--
		}
		for k := g.rev.start[v]; k < g.rev.start[v+1]; k++ {
			w := g.rev.to[k]
			if d := dist[v] + g.rev.sec[k]*factor; d < dist[w] {
				dist[w] = d
				pq.push(item{w, d})
			}
		}
	}
	out := make([]float64, len(sources))
	for i, s := range sources {
		if closed[s] {
			out[i] = dist[s]
		} else {
			out[i] = math.Inf(1)
		}
	}
	return out
}

type item struct {
	node     int32
	priority float64
}

type queue []item

func (q *queue) push(it item) {
	*q = append(*q, it)
	h := *q
	i := len(h) - 1
	for i > 0 {
		p := (i - 1) / 2
		if h[p].priority <= h[i].priority {
			break
		}
		h[p], h[i] = h[i], h[p]
		i = p
	}
}

func (q *queue) pop() item {
	h := *q
	top := h[0]
	last := len(h) - 1
	h[0] = h[last]
	h = h[:last]
	i := 0
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < len(h) && h[l].priority < h[m].priority {
			m = l
		}
		if r < len(h) && h[r].priority < h[m].priority {
			m = r
		}
		if m == i {
			break
		}
		h[i], h[m] = h[m], h[i]
		i = m
	}
	*q = h
	return top
}
