package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/jvS0uzx/gdrive/engine/internal/live"
)

type Config struct {
	APIURL      string
	EngineURL   string
	Couriers    int
	OrderEvery  time.Duration
	Speed       float64
	Tick        time.Duration
	AcceptRate  float64
	DeclineRate float64
	StoreRadius float64
	Seed        uint64
	Attempts    int
	RetryDelay  time.Duration
}

type Store struct {
	ID   int64   `json:"id"`
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type Address struct {
	ID  int64   `json:"id"`
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type courierInfo struct {
	ID  int64   `json:"id"`
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type Path struct {
	Coords     [][2]float64
	Cumulative []float64
}

func PositionAt(p Path, elapsed float64) live.Point {
	last := len(p.Coords) - 1
	if last < 0 {
		return live.Point{}
	}
	if elapsed >= p.Cumulative[last] || last == 0 {
		return live.Point{Lat: p.Coords[last][1], Lon: p.Coords[last][0]}
	}
	lo, hi := 0, last
	for hi-lo > 1 {
		mid := (lo + hi) / 2
		if p.Cumulative[mid] <= elapsed {
			lo = mid
		} else {
			hi = mid
		}
	}
	span := p.Cumulative[hi] - p.Cumulative[lo]
	f := 1.0
	if span > 0 {
		f = (elapsed - p.Cumulative[lo]) / span
	}
	a, b := p.Coords[lo], p.Coords[hi]
	return live.Point{Lat: a[1] + (b[1]-a[1])*f, Lon: a[0] + (b[0]-a[0])*f}
}

const (
	ControlKey   = "sim:control"
	CommandsKey  = "sim:commands"
	detourMeters = 700.0
	controlEvery = 2 * time.Second
)

type courier struct {
	id      int64
	mu      sync.Mutex
	pos     live.Point
	path    *Path
	elapsed float64
	dest    *live.Point
	frozen  time.Time
	muted   time.Time
}

func (c *courier) follow(p *Path) {
	c.mu.Lock()
	c.path, c.elapsed = p, 0
	c.mu.Unlock()
}

func (c *courier) head(p *Path, dest live.Point) {
	c.mu.Lock()
	c.path, c.elapsed, c.dest = p, 0, &dest
	c.mu.Unlock()
}

func (c *courier) stop() {
	c.mu.Lock()
	c.path, c.dest = nil, nil
	c.mu.Unlock()
}

func (c *courier) step(seconds float64) live.Point {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path != nil && !time.Now().Before(c.frozen) {
		c.elapsed += seconds
		c.pos = PositionAt(*c.path, c.elapsed)
	}
	return c.pos
}

func (c *courier) silent() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Before(c.muted)
}

func (c *courier) destination() *live.Point {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path == nil {
		return nil
	}
	return c.dest
}

func (c *courier) position() live.Point {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pos
}

type order struct {
	store    int64
	courier  int64
	atStore  bool
	ready    bool
	pickedUp bool
}

type Sim struct {
	cfg      Config
	log      *slog.Logger
	rdb      *redis.Client
	http     *http.Client
	mu       sync.Mutex
	rng      *rand.Rand
	couriers map[int64]*courier
	orders   map[int64]*order
	stores   []Store
	nearby   map[int64][]Address
	rush     float64
}

func New(cfg Config, rdb *redis.Client, log *slog.Logger) *Sim {
	return &Sim{
		cfg:      cfg,
		log:      log,
		rdb:      rdb,
		http:     &http.Client{Timeout: 15 * time.Second},
		rng:      rand.New(rand.NewPCG(cfg.Seed, 11)),
		couriers: map[int64]*courier{},
		orders:   map[int64]*order{},
		nearby:   map[int64][]Address{},
		rush:     1,
	}
}

func (s *Sim) roll() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rng.Float64()
}

func (s *Sim) intn(n int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rng.IntN(n)
}

func (s *Sim) between(lo, hi time.Duration) time.Duration {
	return lo + time.Duration(s.roll()*float64(hi-lo))
}

func (s *Sim) call(ctx context.Context, method, url string, body, out any) error {
	var reader *bytes.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return statusError{method: method, url: url, code: resp.StatusCode}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

type statusError struct {
	method, url string
	code        int
}

func (e statusError) Error() string {
	return fmt.Sprintf("%s %s: %d", e.method, e.url, e.code)
}

func (s *Sim) api(path string) string    { return strings.TrimRight(s.cfg.APIURL, "/") + path }
func (s *Sim) engine(path string) string { return strings.TrimRight(s.cfg.EngineURL, "/") + path }

func (s *Sim) load(ctx context.Context) ([]courierInfo, error) {
	var couriers []courierInfo
	if err := s.call(ctx, http.MethodGet, s.api(fmt.Sprintf("/api/couriers?human=false&limit=%d", s.cfg.Couriers)), nil, &couriers); err != nil {
		return nil, err
	}
	if err := s.call(ctx, http.MethodGet, s.api("/api/stores?limit=5000"), nil, &s.stores); err != nil {
		return nil, err
	}
	var customers []Address
	if err := s.call(ctx, http.MethodGet, s.api("/api/addresses?kind=customer&limit=20000"), nil, &customers); err != nil {
		return nil, err
	}
	for _, st := range s.stores {
		for _, a := range customers {
			d := live.Distance(live.Point{Lat: st.Lat, Lon: st.Lon}, live.Point{Lat: a.Lat, Lon: a.Lon})
			if d >= 300 && d <= s.cfg.StoreRadius {
				s.nearby[st.ID] = append(s.nearby[st.ID], a)
			}
		}
	}
	return couriers, nil
}

func (s *Sim) Run(ctx context.Context) error {
	var infos []courierInfo
	var err error
	for attempt := 0; attempt < 60; attempt++ {
		if infos, err = s.load(ctx); err == nil && len(s.stores) > 0 {
			break
		}
		s.log.Info("esperando a api", "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	if err != nil {
		return err
	}
	last := "0-0"
	if past, err := s.rdb.XRevRangeN(ctx, live.OrdersStream, "+", "-", 1).Result(); err == nil && len(past) == 1 {
		last = past[0].ID
	}
	for _, info := range infos {
		c := &courier{id: info.ID, pos: s.lastPosition(ctx, info)}
		s.couriers[info.ID] = c
		if err := s.call(ctx, http.MethodPost, s.api(fmt.Sprintf("/api/couriers/%d/online", info.ID)), nil, nil); err != nil && !busy(err) {
			s.log.Warn("entregador não ficou online", "id", info.ID, "err", err)
		}
		go s.drive(ctx, c)
	}
	resumed := s.resume(ctx)
	s.log.Info("simulação no ar", "entregadores", len(infos), "lojas", len(s.stores), "pedidos_retomados", resumed)
	go s.controls(ctx)
	go s.commands(ctx)
	go s.customers(ctx)
	return s.follow(ctx, last)
}

func (s *Sim) controls(ctx context.Context) {
	tick := time.NewTicker(controlEvery)
	defer tick.Stop()
	for {
		rush := 1.0
		if v, err := s.rdb.HGet(ctx, ControlKey, "rush").Result(); err == nil {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				rush = max(1, min(10, f))
			}
		}
		s.mu.Lock()
		s.rush = rush
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

type Command struct {
	Action  string `json:"action"`
	Courier int64  `json:"courier_id"`
	Seconds int    `json:"seconds"`
}

func (s *Sim) commands(ctx context.Context) {
	sub := s.rdb.Subscribe(ctx, CommandsKey)
	defer sub.Close()
	for msg := range sub.Channel() {
		var cmd Command
		if json.Unmarshal([]byte(msg.Payload), &cmd) != nil {
			continue
		}
		s.apply(ctx, cmd)
	}
}

func (s *Sim) apply(ctx context.Context, cmd Command) {
	c, ours := s.couriers[cmd.Courier]
	if !ours {
		return
	}
	until := time.Now().Add(time.Duration(cmd.Seconds) * time.Second)
	s.log.Info("comando da simulação", "acao", cmd.Action, "courier", cmd.Courier, "segundos", cmd.Seconds)
	switch cmd.Action {
	case "sem_sinal":
		c.mu.Lock()
		c.muted = until
		c.mu.Unlock()
	case "parar":
		c.mu.Lock()
		c.frozen = until
		c.mu.Unlock()
	case "desviar":
		go s.detour(ctx, c)
	}
}

func busy(err error) bool {
	var status statusError
	return errors.As(err, &status) && status.code == http.StatusConflict
}

func (s *Sim) lastPosition(ctx context.Context, info courierInfo) live.Point {
	vals, err := s.rdb.HMGet(ctx, live.CourierKey(info.ID), "lat", "lon").Result()
	if err == nil && len(vals) == 2 {
		lat, ok1 := vals[0].(string)
		lon, ok2 := vals[1].(string)
		var p live.Point
		if ok1 && ok2 {
			if _, err := fmt.Sscan(lat, &p.Lat); err == nil {
				if _, err := fmt.Sscan(lon, &p.Lon); err == nil {
					return p
				}
			}
		}
	}
	return live.Point{Lat: info.Lat, Lon: info.Lon}
}

type orderDetail struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
	Store  struct {
		ID     int64   `json:"id"`
		Lat    float64 `json:"lat"`
		Lon    float64 `json:"lon"`
		Manual bool    `json:"manual"`
	} `json:"store"`
	Customer live.Point `json:"customer"`
	Courier  *struct {
		ID int64 `json:"id"`
	} `json:"courier"`
	ReadyAt *string `json:"ready_at"`
}

func (s *Sim) resume(ctx context.Context) int {
	resumed := 0
	for _, status := range []string{"aguardando_loja", "em_preparo", "a_caminho_da_loja", "na_loja", "em_rota", "no_cliente"} {
		var list []struct {
			ID int64 `json:"id"`
		}
		if err := s.call(ctx, http.MethodGet, s.api("/api/orders?limit=500&status="+status), nil, &list); err != nil {
			s.log.Warn("pedidos em andamento não lidos", "status", status, "err", err)
			continue
		}
		for _, item := range list {
			var d orderDetail
			if err := s.call(ctx, http.MethodGet, s.api(fmt.Sprintf("/api/orders/%d", item.ID)), nil, &d); err != nil {
				continue
			}
			if s.resumeOrder(ctx, d) {
				resumed++
			}
		}
	}
	return resumed
}

func (s *Sim) resumeOrder(ctx context.Context, d orderDetail) bool {
	o := &order{store: d.Store.ID, ready: d.ReadyAt != nil}
	var c *courier
	if d.Courier != nil {
		o.courier = d.Courier.ID
		c = s.couriers[d.Courier.ID]
	}
	s.mu.Lock()
	s.orders[d.ID] = o
	s.mu.Unlock()
	store := live.Point{Lat: d.Store.Lat, Lon: d.Store.Lon}
	switch d.Status {
	case "aguardando_loja":
		if !d.Store.Manual {
			s.storeAccepts(ctx, d.ID, d.Store.ID)
		}
		return true
	case "em_preparo", "a_caminho_da_loja", "na_loja":
		if !o.ready && !d.Store.Manual {
			s.later(ctx, s.between(5*time.Second, 20*time.Second), func() {
				s.post(ctx, fmt.Sprintf("/api/stores/%d/orders/%d/ready", d.Store.ID, d.ID), nil)
			})
		}
	}
	if c == nil {
		return d.Status == "em_preparo"
	}
	switch d.Status {
	case "a_caminho_da_loja":
		go s.travel(ctx, c, store)
	case "na_loja":
		s.mu.Lock()
		o.atStore = true
		s.mu.Unlock()
		s.tryPickup(ctx, d.ID)
	case "em_rota":
		go s.travel(ctx, c, d.Customer)
	case "no_cliente":
		s.later(ctx, s.between(time.Second, 3*time.Second), func() {
			s.post(ctx, fmt.Sprintf("/api/orders/%d/deliver", d.ID), map[string]int64{"courier_id": c.id})
		})
	}
	return true
}

func (s *Sim) storeAccepts(ctx context.Context, orderID, storeID int64) {
	prep := 8 + s.intn(13)
	s.later(ctx, s.between(time.Second, 3*time.Second), func() {
		s.post(ctx, fmt.Sprintf("/api/stores/%d/orders/%d/accept", storeID, orderID), map[string]int{"prep_minutes": prep})
		s.later(ctx, time.Duration(float64(prep)*60/s.cfg.Speed*float64(time.Second)), func() {
			s.post(ctx, fmt.Sprintf("/api/stores/%d/orders/%d/ready", storeID, orderID), nil)
		})
	})
}

func (s *Sim) drive(ctx context.Context, c *courier) {
	ws := strings.Replace(strings.Replace(s.engine(fmt.Sprintf("/ws/courier?id=%d", c.id)), "http://", "ws://", 1), "https://", "wss://", 1)
	for ctx.Err() == nil {
		conn, _, err := websocket.Dial(ctx, ws, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		tick := time.NewTicker(s.cfg.Tick)
		for ctx.Err() == nil {
			p := c.step(s.cfg.Tick.Seconds() * s.cfg.Speed)
			if c.silent() {
				<-tick.C
				continue
			}
			data, _ := json.Marshal(p)
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				break
			}
			<-tick.C
		}
		tick.Stop()
		conn.CloseNow()
	}
}

func (s *Sim) customers(ctx context.Context) {
	for ctx.Err() == nil {
		s.mu.Lock()
		rush := s.rush
		s.mu.Unlock()
		wait := time.Duration(float64(s.between(s.cfg.OrderEvery/2, s.cfg.OrderEvery*3/2)) / rush)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		store := s.stores[s.intn(len(s.stores))]
		options := s.nearby[store.ID]
		if len(options) == 0 {
			continue
		}
		customer := options[s.intn(len(options))]
		var created struct {
			ID int64 `json:"id"`
		}
		if err := s.call(ctx, http.MethodPost, s.api("/api/orders"), map[string]int64{"store_id": store.ID, "address_id": customer.ID}, &created); err != nil {
			s.log.Warn("pedido não criado", "err", err)
		}
	}
}

func (s *Sim) follow(ctx context.Context, last string) error {
	for ctx.Err() == nil {
		res, err := s.rdb.XRead(ctx, &redis.XReadArgs{Streams: []string{live.OrdersStream, last}, Block: 5 * time.Second, Count: 200}).Result()
		if err != nil {
			if !errors.Is(err, redis.Nil) && ctx.Err() == nil {
				s.log.Warn("leitura de events.orders", "err", err)
				time.Sleep(time.Second)
			}
			continue
		}
		for _, stream := range res {
			for _, msg := range stream.Messages {
				last = msg.ID
				raw, _ := msg.Values["data"].(string)
				var e event
				if json.Unmarshal([]byte(raw), &e) == nil {
					s.handle(ctx, e)
				}
			}
		}
	}
	return ctx.Err()
}

type event struct {
	live.Event
	StoreID int64 `json:"store_id"`
	Manual  bool  `json:"manual"`
}

func (s *Sim) later(ctx context.Context, d time.Duration, f func()) {
	time.AfterFunc(d, func() {
		if ctx.Err() == nil {
			f()
		}
	})
}

func (s *Sim) post(ctx context.Context, path string, body any) {
	delay := s.cfg.RetryDelay
	for attempt := 1; ; attempt++ {
		err := s.call(ctx, http.MethodPost, s.api(path), body, nil)
		if err == nil {
			return
		}
		var status statusError
		if errors.As(err, &status) && status.code < http.StatusInternalServerError {
			s.log.Debug("ação recusada", "path", path, "err", err)
			return
		}
		if attempt >= s.cfg.Attempts || ctx.Err() != nil {
			s.log.Warn("ação perdida depois de várias tentativas", "path", path, "tentativas", attempt, "err", err)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay *= 2
	}
}

func (s *Sim) handle(ctx context.Context, e event) {
	s.mu.Lock()
	o := s.orders[e.Order]
	if o == nil {
		o = &order{}
		s.orders[e.Order] = o
	}
	s.mu.Unlock()

	switch e.Type {
	case "pedido_criado":
		s.mu.Lock()
		o.store = e.StoreID
		s.mu.Unlock()
		if !e.Manual {
			s.storeAccepts(ctx, e.Order, e.StoreID)
		}
	case "oferta_enviada":
		if c, ours := s.couriers[e.Courier]; !ours || c.silent() {
			return
		}
		r := s.roll()
		s.later(ctx, s.between(time.Second, 6*time.Second), func() {
			switch {
			case r < s.cfg.AcceptRate:
				s.post(ctx, fmt.Sprintf("/api/offers/%d/accept", e.Offer), map[string]int64{"courier_id": e.Courier})
			case r < s.cfg.AcceptRate+s.cfg.DeclineRate:
				s.post(ctx, fmt.Sprintf("/api/offers/%d/decline", e.Offer), map[string]int64{"courier_id": e.Courier})
			}
		})
	case "entregador_atribuido":
		c, ours := s.couriers[e.Courier]
		if !ours || e.Store == nil {
			return
		}
		s.mu.Lock()
		o.courier = e.Courier
		s.mu.Unlock()
		go s.travel(ctx, c, *e.Store)
	case "entregador_desatribuido":
		s.mu.Lock()
		o.courier, o.atStore, o.pickedUp = 0, false, false
		s.mu.Unlock()
		if c, ours := s.couriers[e.Courier]; ours {
			c.stop()
		}
	case "entregador_chegou_na_loja":
		s.mu.Lock()
		o.atStore = true
		s.mu.Unlock()
		s.tryPickup(ctx, e.Order)
	case "pedido_pronto":
		s.mu.Lock()
		o.ready = true
		s.mu.Unlock()
		s.tryPickup(ctx, e.Order)
	case "pedido_coletado":
		c, ours := s.couriers[e.Courier]
		if !ours || e.Customer == nil {
			return
		}
		go s.travel(ctx, c, *e.Customer)
	case "entregador_chegou_no_cliente":
		if _, ours := s.couriers[e.Courier]; !ours {
			return
		}
		s.later(ctx, s.between(time.Second, 3*time.Second), func() {
			s.post(ctx, fmt.Sprintf("/api/orders/%d/deliver", e.Order), map[string]int64{"courier_id": e.Courier})
		})
	case "pedido_entregue", "pedido_cancelado", "pedido_recusado_pela_loja", "pedido_expirado_na_loja":
		if c, ours := s.couriers[e.Courier]; ours && e.Type == "pedido_cancelado" {
			c.stop()
		}
		s.mu.Lock()
		delete(s.orders, e.Order)
		s.mu.Unlock()
	}
}

func (s *Sim) tryPickup(ctx context.Context, id int64) {
	s.mu.Lock()
	o := s.orders[id]
	ok := o != nil && o.atStore && o.ready && !o.pickedUp && o.courier != 0
	if ok {
		o.pickedUp = true
	}
	courierID := int64(0)
	if o != nil {
		courierID = o.courier
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.later(ctx, s.between(time.Second, 2*time.Second), func() {
		s.post(ctx, fmt.Sprintf("/api/orders/%d/pickup", id), map[string]int64{"courier_id": courierID})
	})
}

type routeResponse struct {
	Path struct {
		Coordinates [][2]float64 `json:"coordinates"`
	} `json:"path"`
	Cumulative []float64 `json:"cumulative_seconds"`
}

func (s *Sim) route(ctx context.Context, from, to live.Point) (*Path, error) {
	var r routeResponse
	if err := s.call(ctx, http.MethodPost, s.engine("/route"), map[string]any{"from": from, "to": to}, &r); err != nil {
		return nil, err
	}
	if len(r.Path.Coordinates) == 0 || len(r.Cumulative) != len(r.Path.Coordinates) {
		return nil, errors.New("rota vazia")
	}
	return &Path{Coords: r.Path.Coordinates, Cumulative: r.Cumulative}, nil
}

func (s *Sim) travel(ctx context.Context, c *courier, to live.Point) {
	from := c.position()
	p, err := s.route(ctx, from, to)
	if err != nil {
		s.log.Warn("rota não calculada", "courier", c.id, "err", err)
		p = &Path{Coords: [][2]float64{{from.Lon, from.Lat}, {to.Lon, to.Lat}}, Cumulative: []float64{0, math.Max(1, live.Distance(from, to)/8)}}
	}
	c.head(p, to)
}

func Waypoints(from, to live.Point, meters float64) [2]live.Point {
	mid := live.Point{Lat: (from.Lat + to.Lat) / 2, Lon: (from.Lon + to.Lon) / 2}
	scale := math.Cos(mid.Lat * math.Pi / 180)
	dx, dy := (to.Lon-from.Lon)*scale, to.Lat-from.Lat
	n := math.Hypot(dx, dy)
	if n == 0 {
		dx, dy, n = 1, 0, 1
	}
	off := meters / 111_320
	side := func(sign float64) live.Point {
		return live.Point{Lat: mid.Lat + sign*dx/n*off, Lon: mid.Lon - sign*dy/n*off/scale}
	}
	return [2]live.Point{side(1), side(-1)}
}

func Join(a, b *Path) *Path {
	out := &Path{Coords: append([][2]float64{}, a.Coords...), Cumulative: append([]float64{}, a.Cumulative...)}
	offset := a.Cumulative[len(a.Cumulative)-1]
	for i := 1; i < len(b.Coords); i++ {
		out.Coords = append(out.Coords, b.Coords[i])
		out.Cumulative = append(out.Cumulative, offset+b.Cumulative[i])
	}
	return out
}

func (s *Sim) detour(ctx context.Context, c *courier) {
	dest := c.destination()
	if dest == nil {
		return
	}
	from := c.position()
	for _, way := range Waypoints(from, *dest, detourMeters) {
		first, err := s.route(ctx, from, way)
		if err != nil {
			continue
		}
		second, err := s.route(ctx, way, *dest)
		if err != nil {
			continue
		}
		c.head(Join(first, second), *dest)
		return
	}
	s.log.Warn("desvio sem caminho pelos dois lados", "courier", c.id)
}
