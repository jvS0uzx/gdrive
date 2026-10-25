package load

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
	"github.com/jvS0uzx/gdrive/engine/internal/live"
	"github.com/jvS0uzx/gdrive/engine/internal/route"
	"github.com/jvS0uzx/gdrive/engine/internal/sim"
)

// Pedido sintético bem acima de qualquer id do Postgres: o worker recebe a chegada, não acha o
// pedido e descarta, sem tocar em pedido de verdade.
const orderOffset = 9_000_000_000

type Config struct {
	Target    string
	Couriers  int
	FirstID   int64
	Tick      time.Duration
	Speed     float64
	Busy      float64
	RampStep  int
	RampEvery time.Duration
	Routes    int
	Seed      uint64
}

var (
	connected = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "gdrive_load_couriers_connected",
		Help: "Entregadores sintéticos com WebSocket aberto.",
	})
	started = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "gdrive_load_couriers_started",
		Help: "Entregadores sintéticos já lançados pela rampa.",
	})
	sent = promauto.NewCounter(prometheus.CounterOpts{
		Name: "gdrive_load_positions_sent_total",
		Help: "Posições escritas no WebSocket pelo gerador.",
	})
	failures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "gdrive_load_errors_total",
		Help: "Falhas do gerador, por etapa.",
	}, []string{"stage"})
	writeSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gdrive_load_write_seconds",
		Help:    "Tempo para escrever uma posição no WebSocket.",
		Buckets: prometheus.ExponentialBuckets(0.0001, 2, 15),
	})
)

func init() {
	for _, stage := range []string{"dial", "write", "target"} {
		failures.WithLabelValues(stage)
	}
}

// Routes sorteia trechos entre endereços da cidade e devolve cada um como ida e volta, para o
// entregador rodar em círculo pelas ruas sem pedir rota ao engine durante a carga. As buscas
// rodam em paralelo por lote, na ordem do sorteio: a mesma semente dá as mesmas rotas.
func Routes(c *city.City, g *route.Graph, n int, rng *rand.Rand) []sim.Path {
	pool := make([]sim.Path, 0, max(n, 0))
	if len(c.Addresses) < 2 || n <= 0 {
		return pool
	}
	workers := runtime.GOMAXPROCS(0)
	batch := make([][2]int32, 0, workers*4)
	for tries := 0; len(pool) < n && tries < n*20; {
		batch = batch[:0]
		for len(batch) < cap(batch) && tries < n*20 {
			tries++
			a := c.Addresses[rng.IntN(len(c.Addresses))].Node
			b := c.Addresses[rng.IntN(len(c.Addresses))].Node
			// Linha reta acima de 6 km nunca vira rota de até 6 km; abaixo de 1 km quase nunca passa de 1,5.
			aLat, aLon := c.LatLon(a)
			bLat, bLon := c.LatLon(b)
			if d := live.Distance(live.Point{Lat: aLat, Lon: aLon}, live.Point{Lat: bLat, Lon: bLon}); d < 1000 || d > 6000 {
				continue
			}
			batch = append(batch, [2]int32{a, b})
		}
		found := make([]*sim.Path, len(batch))
		var wg sync.WaitGroup
		for w := range workers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := w; i < len(batch); i += workers {
					a, b := batch[i][0], batch[i][1]
					there, ok := g.Shortest(a, b, 1)
					if !ok || there.Meters < 1500 || there.Meters > 6000 {
						continue
					}
					if back, ok := g.Shortest(b, a, 1); ok {
						found[i] = sim.Join(toPath(c, there), toPath(c, back))
					}
				}
			}()
		}
		wg.Wait()
		for _, p := range found {
			if p != nil && len(pool) < n {
				pool = append(pool, *p)
			}
		}
	}
	return pool
}

func toPath(c *city.City, p route.Path) *sim.Path {
	out := &sim.Path{Coords: make([][2]float64, len(p.Nodes)), Cumulative: p.Cumulative}
	for i, n := range p.Nodes {
		out.Coords[i] = c.Point(n)
	}
	return out
}

type courier struct {
	id      int64
	path    sim.Path
	elapsed float64
	busy    bool
}

func (c *courier) total() float64 {
	return c.path.Cumulative[len(c.path.Cumulative)-1]
}

func (c *courier) step(seconds float64) live.Point {
	if total := c.total(); total > 0 {
		c.elapsed += seconds
		for c.elapsed >= total {
			c.elapsed -= total
		}
	}
	return sim.PositionAt(c.path, c.elapsed)
}

// O alvo fica no meio da volta (o fim da ida): o engine planeja a rota até lá, grava o rastro
// a cada posição e dispara a chegada uma vez, como numa corrida de verdade.
func (c *courier) target() live.Point {
	return sim.PositionAt(c.path, c.total()/2)
}

type Load struct {
	cfg  Config
	rdb  *redis.Client
	log  *slog.Logger
	pool []sim.Path

	mu       sync.Mutex
	couriers []*courier

	positions atomic.Int64
	failed    atomic.Int64
}

// Totals devolve as posições escritas e as falhas desde o início, para o teste de fumaça da CI
// reprovar sem depender de Prometheus.
func (l *Load) Totals() (positions, failed int64) {
	return l.positions.Load(), l.failed.Load()
}

func New(cfg Config, pool []sim.Path, rdb *redis.Client, log *slog.Logger) *Load {
	return &Load{cfg: cfg, rdb: rdb, log: log, pool: pool}
}

// Run lança a rampa e devolve quando o contexto acaba e todos os entregadores fecharam.
func (l *Load) Run(ctx context.Context) error {
	if len(l.pool) == 0 {
		return errors.New("nenhuma rota sorteada para a carga")
	}
	rng := rand.New(rand.NewPCG(l.cfg.Seed, l.cfg.Seed^0x9e3779b97f4a7c15))
	step := max(1, l.cfg.RampStep)
	var wg sync.WaitGroup
	for i := 0; i < l.cfg.Couriers; i++ {
		if i > 0 && i%step == 0 {
			l.log.Info("rampa", "lançados", i)
			select {
			case <-ctx.Done():
				wg.Wait()
				return nil
			case <-time.After(l.cfg.RampEvery):
			}
		}
		path := l.pool[i%len(l.pool)]
		c := &courier{id: l.cfg.FirstID + int64(i), path: path, busy: rng.Float64() < l.cfg.Busy}
		c.elapsed = rng.Float64() * c.total()
		phase := time.Duration(rng.Int64N(int64(max(time.Millisecond, l.cfg.Tick))))
		l.mu.Lock()
		l.couriers = append(l.couriers, c)
		l.mu.Unlock()
		started.Inc()
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.drive(ctx, c, phase)
		}()
	}
	l.log.Info("rampa completa", "entregadores", l.cfg.Couriers)
	wg.Wait()
	return nil
}

func (l *Load) drive(ctx context.Context, c *courier, phase time.Duration) {
	if c.busy {
		at := c.target()
		order := strconv.FormatInt(orderOffset+c.id, 10)
		err := l.rdb.HSet(ctx, live.TargetKey(c.id), "order_id", order, "phase", "cliente", "lat", at.Lat, "lon", at.Lon).Err()
		if err != nil && ctx.Err() == nil {
			failures.WithLabelValues("target").Inc()
			l.failed.Add(1)
		}
	}
	url := strings.TrimRight(l.cfg.Target, "/") + "/ws/courier?id=" + strconv.FormatInt(c.id, 10)
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		conn, _, err := websocket.Dial(dctx, url, nil)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			failures.WithLabelValues("dial").Inc()
			l.failed.Add(1)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(10*time.Second, backoff*2)
			continue
		}
		backoff = 500 * time.Millisecond
		connected.Inc()
		l.send(ctx, conn, c, phase)
		connected.Dec()
		conn.CloseNow()
	}
}

func (l *Load) send(ctx context.Context, conn *websocket.Conn, c *courier, phase time.Duration) {
	// Fase aleatória dentro do tique: sem ela, 20 mil entregadores escrevem no mesmo instante.
	select {
	case <-ctx.Done():
		return
	case <-time.After(phase):
	}
	tick := time.NewTicker(l.cfg.Tick)
	defer tick.Stop()
	for {
		p := c.step(l.cfg.Tick.Seconds() * l.cfg.Speed)
		data, _ := json.Marshal(p)
		began := time.Now()
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := conn.Write(wctx, websocket.MessageText, data)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				failures.WithLabelValues("write").Inc()
				l.failed.Add(1)
			}
			return
		}
		writeSeconds.Observe(time.Since(began).Seconds())
		sent.Inc()
		l.positions.Add(1)
		select {
		case <-ctx.Done():
			_ = conn.Close(websocket.StatusNormalClosure, "fim da carga")
			return
		case <-tick.C:
		}
	}
}

// Cleanup apaga do Redis o que a carga criou. Rastro e rota prevista têm TTL de 24 h, e 20 mil
// entregadores deixariam centenas de MB parados até lá.
func (l *Load) Cleanup(ctx context.Context) error {
	l.mu.Lock()
	couriers := append([]*courier(nil), l.couriers...)
	l.mu.Unlock()
	for start := 0; start < len(couriers); start += 1000 {
		pipe := l.rdb.Pipeline()
		for _, c := range couriers[start:min(start+1000, len(couriers))] {
			pipe.ZRem(ctx, live.GeoKey, strconv.FormatInt(c.id, 10))
			pipe.Del(ctx, live.CourierKey(c.id), live.TargetKey(c.id))
			if c.busy {
				order := orderOffset + c.id
				pipe.Del(ctx, live.PlanKey(order), live.TrackKey(order, "loja"), live.TrackKey(order, "cliente"))
			}
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}
