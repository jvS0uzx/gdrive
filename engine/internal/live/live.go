package live

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
)

const (
	GeoKey          = "geo:couriers"
	PositionsTopic  = "live:positions"
	OrdersStream    = "events.orders"
	TrackingStream  = "events.tracking"
	WeatherKey      = "city:weather"
	arrivalMeters   = 50.0
	stopMeters      = 25.0
	offRouteMeters  = 150.0
	offRouteSamples = 3
	backOnRoute     = 60.0
	weatherEvery    = 2 * time.Second
	streamMax       = 200_000
	snapshotEvery   = 500 * time.Millisecond
	targetEvery     = time.Second
	targetChunk     = 1000
	flushEvery      = 20 * time.Millisecond
	flushMax        = 2000
	writeQueue      = 1 << 16
	staleAfter      = 20 * time.Second
	replayEntries   = 20000
)

func CourierKey(id int64) string { return "courier:" + strconv.FormatInt(id, 10) }
func TargetKey(id int64) string  { return "target:" + strconv.FormatInt(id, 10) }
func PlanKey(order int64) string { return "plan:" + strconv.FormatInt(order, 10) }
func TrackKey(order int64, phase string) string {
	return "track:" + strconv.FormatInt(order, 10) + ":" + phase
}

const (
	journeyTTL          = 24 * time.Hour
	trackLimit          = 5000
	defaultStoppedAfter = 60 * time.Second
)

type Plan struct {
	From    [2]float64   `json:"from"`
	Path    [][2]float64 `json:"path"`
	Seconds float64      `json:"seconds"`
	Meters  float64      `json:"meters"`
	At      int64        `json:"at"`
}

type Planner func(from, to Point) (Plan, bool)

type Point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type position struct {
	Courier int64   `json:"courier_id"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Order   int64   `json:"order_id,omitempty"`
	Phase   string  `json:"phase,omitempty"`
	At      int64   `json:"at"`
}

type Event struct {
	Type     string  `json:"type"`
	Order    int64   `json:"order_id"`
	Version  int     `json:"version"`
	Status   string  `json:"status"`
	Courier  int64   `json:"courier_id,omitempty"`
	Store    *Point  `json:"store,omitempty"`
	Customer *Point  `json:"customer,omitempty"`
	Name     string  `json:"store_name,omitempty"`
	Offer    int64   `json:"offer_id,omitempty"`
	ETA      float64 `json:"eta_seconds,omitempty"`
	Alert    string  `json:"alert,omitempty"`
	AlertAt  int64   `json:"alert_at,omitempty"`
}

type orderState struct {
	ID       int64            `json:"id"`
	Status   string           `json:"status"`
	Version  int              `json:"version"`
	Store    *Point           `json:"store,omitempty"`
	Customer *Point           `json:"customer,omitempty"`
	Name     string           `json:"store_name,omitempty"`
	Courier  int64            `json:"courier_id,omitempty"`
	Alerts   map[string]int64 `json:"alerts,omitempty"`
}

type courierState struct {
	pos  position
	seen time.Time
}

// write é uma posição esperando o próximo lote: gravada no Redis e publicada junto com as
// outras, em vez de uma ida e volta por posição.
type write struct {
	pos   position
	track string
	point string
}

type cachedTarget struct {
	fields map[string]string
	read   time.Time
}

var finished = map[string]bool{"entregue": true, "cancelado": true, "recusado": true}

type Hub struct {
	planner      Planner
	stoppedAfter time.Duration
	rain         atomic.Bool
	rdb          *redis.Client
	log          *slog.Logger
	mu           sync.RWMutex
	couriers     map[int64]*courierState
	orders       map[int64]*orderState
	central      map[chan []byte]struct{}
	watchers     map[int64]map[chan []byte]struct{}
	writes       chan write

	targetsMu sync.Mutex
	targets   map[int64]cachedTarget
	online    map[int64]int
}

func New(rdb *redis.Client, log *slog.Logger) *Hub {
	return &Hub{
		stoppedAfter: defaultStoppedAfter,
		rdb:          rdb,
		log:          log,
		couriers:     map[int64]*courierState{},
		orders:       map[int64]*orderState{},
		central:      map[chan []byte]struct{}{},
		watchers:     map[int64]map[chan []byte]struct{}{},
		writes:       make(chan write, writeQueue),
		targets:      map[int64]cachedTarget{},
		online:       map[int64]int{},
	}
}

func (h *Hub) SetPlanner(p Planner) {
	h.planner = p
}

func (h *Hub) SetStoppedAfter(d time.Duration) {
	h.stoppedAfter = d
}

func (h *Hub) Raining() bool {
	return h.rain.Load()
}

func (h *Hub) Run(ctx context.Context) {
	go h.followPositions(ctx)
	go h.flushPositions(ctx)
	go h.refreshTargets(ctx)
	go h.followOrders(ctx)
	go h.followWeather(ctx)
	go h.broadcastSnapshots(ctx)
}

func (h *Hub) followWeather(ctx context.Context) {
	tick := time.NewTicker(weatherEvery)
	defer tick.Stop()
	for {
		v, err := h.rdb.HGet(ctx, WeatherKey, "rain").Result()
		switch {
		case err == nil:
			h.rain.Store(v == "1")
		case errors.Is(err, redis.Nil):
			h.rain.Store(false)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func Distance(a, b Point) float64 {
	const earth = 6_371_000.0
	la1, la2 := a.Lat*math.Pi/180, b.Lat*math.Pi/180
	dLat := la2 - la1
	dLon := (b.Lon - a.Lon) * math.Pi / 180
	s := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earth * math.Asin(math.Sqrt(s))
}

func (h *Hub) followPositions(ctx context.Context) {
	sub := h.rdb.Subscribe(ctx, PositionsTopic)
	defer sub.Close()
	for msg := range sub.Channel() {
		var batch []position
		if err := json.Unmarshal([]byte(msg.Payload), &batch); err != nil {
			continue
		}
		now := time.Now()
		h.mu.Lock()
		for _, p := range batch {
			h.couriers[p.Courier] = &courierState{pos: p, seen: now}
		}
		h.mu.Unlock()
		for _, p := range batch {
			positionFanout.Observe(now.Sub(time.UnixMilli(p.At)).Seconds())
			if p.Order != 0 {
				data, _ := json.Marshal(map[string]any{"type": "posicao", "courier_id": p.Courier, "lat": p.Lat, "lon": p.Lon, "phase": p.Phase})
				h.toWatchers(p.Order, data)
			}
		}
	}
}

// flushPositions junta as posições desta instância e grava a cada flushEvery (ou a cada
// flushMax): com 10 mil posições/s, uma ida e volta por posição esgotava o pool do Redis.
func (h *Hub) flushPositions(ctx context.Context) {
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	batch := make([]write, 0, flushMax)
	for {
		select {
		case <-ctx.Done():
			if len(batch) > 0 {
				last, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				h.flush(last, batch)
				cancel()
			}
			return
		case w := <-h.writes:
			batch = append(batch, w)
			if len(batch) < flushMax {
				continue
			}
		case <-tick.C:
			if len(batch) == 0 {
				continue
			}
		}
		h.flush(ctx, batch)
		batch = batch[:0]
	}
}

func (h *Hub) flush(ctx context.Context, batch []write) {
	began := time.Now()
	pipe := h.rdb.Pipeline()
	locations := make([]*redis.GeoLocation, 0, len(batch))
	positions := make([]position, 0, len(batch))
	tracks := map[string]struct{}{}
	for _, w := range batch {
		locations = append(locations, &redis.GeoLocation{Name: strconv.FormatInt(w.pos.Courier, 10), Longitude: w.pos.Lon, Latitude: w.pos.Lat})
		pipe.HSet(ctx, CourierKey(w.pos.Courier), "lat", w.pos.Lat, "lon", w.pos.Lon, "ts", w.pos.At)
		if w.track != "" {
			pipe.RPush(ctx, w.track, w.point)
			tracks[w.track] = struct{}{}
		}
		positions = append(positions, w.pos)
	}
	pipe.GeoAdd(ctx, GeoKey, locations...)
	for key := range tracks {
		pipe.LTrim(ctx, key, -trackLimit, -1)
		pipe.Expire(ctx, key, journeyTTL)
	}
	data, _ := json.Marshal(positions)
	pipe.Publish(ctx, PositionsTopic, data)
	if _, err := pipe.Exec(ctx); err != nil && ctx.Err() == nil {
		flushErrors.Inc()
		h.log.Warn("lote de posições não gravado", "posições", len(batch), "err", err)
	}
	flushSeconds.Observe(time.Since(began).Seconds())
	batchSize.Observe(float64(len(batch)))
}

// refreshTargets relê em bloco, a cada targetEvery, o alvo de quem está conectado nesta
// instância. Antes era um HGETALL por posição.
func (h *Hub) refreshTargets(ctx context.Context) {
	tick := time.NewTicker(targetEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		h.targetsMu.Lock()
		ids := make([]int64, 0, len(h.online))
		for id := range h.online {
			ids = append(ids, id)
		}
		h.targetsMu.Unlock()
		for start := 0; start < len(ids); start += targetChunk {
			if err := h.readTargets(ctx, ids[start:min(start+targetChunk, len(ids))]); err != nil && ctx.Err() == nil {
				h.log.Warn("alvos não relidos", "err", err)
			}
		}
	}
}

func (h *Hub) readTargets(ctx context.Context, ids []int64) error {
	read := time.Now()
	pipe := h.rdb.Pipeline()
	cmds := make([]*redis.MapStringStringCmd, len(ids))
	for i, id := range ids {
		cmds[i] = pipe.HGetAll(ctx, TargetKey(id))
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return err
	}
	h.targetsMu.Lock()
	defer h.targetsMu.Unlock()
	for i, id := range ids {
		if _, ok := h.online[id]; !ok {
			continue
		}
		if fields, err := cmds[i].Result(); err == nil {
			h.targets[id] = cachedTarget{fields: fields, read: read}
		}
	}
	return nil
}

func (h *Hub) join(ctx context.Context, id int64) {
	h.targetsMu.Lock()
	h.online[id]++
	h.targetsMu.Unlock()
	// Leitura imediata na conexão: sem ela, a primeira posição de quem já está em corrida
	// passaria sem alvo até a próxima volta do refreshTargets.
	if err := h.readTargets(ctx, []int64{id}); err != nil {
		h.log.Warn("alvo não lido na conexão", "courier", id, "err", err)
	}
}

func (h *Hub) leave(id int64) {
	h.targetsMu.Lock()
	defer h.targetsMu.Unlock()
	if h.online[id]--; h.online[id] <= 0 {
		delete(h.online, id)
		delete(h.targets, id)
	}
}

func (h *Hub) cachedTarget(id int64) (cachedTarget, bool) {
	h.targetsMu.Lock()
	defer h.targetsMu.Unlock()
	c, ok := h.targets[id]
	return c, ok
}

func (h *Hub) apply(e Event) {
	h.mu.Lock()
	o, ok := h.orders[e.Order]
	if !ok {
		o = &orderState{ID: e.Order}
		h.orders[e.Order] = o
	}
	if e.Version >= o.Version {
		o.Version, o.Status = e.Version, e.Status
		if e.Store != nil {
			o.Store = e.Store
		}
		if e.Name != "" {
			o.Name = e.Name
		}
		if e.Customer != nil {
			o.Customer = e.Customer
		}
		switch e.Type {
		case "entregador_atribuido":
			o.Courier = e.Courier
		case "entregador_desatribuido":
			o.Courier = 0
		}
		if e.Alert != "" {
			if e.Type == "alerta_resolvido" {
				delete(o.Alerts, e.Alert)
			} else {
				if o.Alerts == nil {
					o.Alerts = map[string]int64{}
				}
				o.Alerts[e.Alert] = e.AlertAt
			}
		}
	}
	h.mu.Unlock()
}

func decode(msg redis.XMessage) (Event, bool) {
	raw, ok := msg.Values["data"].(string)
	if !ok {
		return Event{}, false
	}
	var e Event
	if err := json.Unmarshal([]byte(raw), &e); err != nil || e.Order == 0 {
		return Event{}, false
	}
	if t, ok := msg.Values["type"].(string); ok && e.Type == "" {
		e.Type = t
	}
	return e, true
}

func (h *Hub) followOrders(ctx context.Context) {
	last := "$"
	if past, err := h.rdb.XRevRangeN(ctx, OrdersStream, "+", "-", replayEntries).Result(); err == nil && len(past) > 0 {
		last = past[0].ID
		for i := len(past) - 1; i >= 0; i-- {
			if e, ok := decode(past[i]); ok {
				h.apply(e)
			}
		}
	}
	for ctx.Err() == nil {
		res, err := h.rdb.XRead(ctx, &redis.XReadArgs{Streams: []string{OrdersStream, last}, Block: 5 * time.Second, Count: 200}).Result()
		if err != nil {
			if !errors.Is(err, redis.Nil) && ctx.Err() == nil {
				h.log.Warn("leitura de events.orders", "err", err)
				time.Sleep(time.Second)
			}
			continue
		}
		for _, stream := range res {
			for _, msg := range stream.Messages {
				last = msg.ID
				e, ok := decode(msg)
				if !ok {
					continue
				}
				h.apply(e)
				data, _ := json.Marshal(map[string]any{"type": "evento", "event": e})
				h.toWatchers(e.Order, data)
			}
		}
	}
}

func (h *Hub) prune(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, c := range h.couriers {
		if now.Sub(c.seen) > staleAfter {
			delete(h.couriers, id)
		}
	}
}

// snapshot copia o estado sob o lock e serializa fora dele. Com 20 mil entregadores o JSON tem
// ~1 MB e leva dezenas de ms; serializado com o lock, a goroutine do pub/sub esperava a cada
// retrato e o p99 do fan-out passava de 300 ms.
func (h *Hub) snapshot() []byte {
	h.mu.RLock()
	couriers := make([][4]float64, 0, len(h.couriers))
	now := time.Now()
	for id, c := range h.couriers {
		if now.Sub(c.seen) > staleAfter {
			continue
		}
		busy := 0.0
		if c.pos.Order != 0 {
			busy = 1
		}
		couriers = append(couriers, [4]float64{float64(id), c.pos.Lon, c.pos.Lat, busy})
	}
	orders := make([]orderState, 0)
	for _, o := range h.orders {
		if !finished[o.Status] && o.Store != nil {
			copied := *o
			copied.Alerts = maps.Clone(o.Alerts)
			orders = append(orders, copied)
		}
	}
	h.mu.RUnlock()
	data, _ := json.Marshal(map[string]any{"type": "snapshot", "couriers": couriers, "orders": orders, "rain": h.Raining()})
	snapshotCouriers.Set(float64(len(couriers)))
	return data
}

func (h *Hub) broadcastSnapshots(ctx context.Context) {
	tick := time.NewTicker(snapshotEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			h.prune(now)
		}
		h.mu.RLock()
		n := len(h.central)
		h.mu.RUnlock()
		if n == 0 {
			continue
		}
		began := time.Now()
		data := h.snapshot()
		snapshotBuild.Observe(time.Since(began).Seconds())
		snapshotBytes.Set(float64(len(data)))
		h.mu.RLock()
		for ch := range h.central {
			select {
			case ch <- data:
			default:
				wsDropped.WithLabelValues("central").Inc()
			}
		}
		h.mu.RUnlock()
	}
}

func (h *Hub) toWatchers(order int64, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.watchers[order] {
		select {
		case ch <- data:
		default:
			wsDropped.WithLabelValues("order").Inc()
		}
	}
}

func (h *Hub) ServeCourier(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "id de entregador inválido", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	connected := wsConnections.WithLabelValues("courier")
	connected.Inc()
	defer connected.Dec()
	ctx := r.Context()
	h.join(ctx, id)
	defer h.leave(id)
	t := tracker{hub: h, id: id}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var p Point
		if json.Unmarshal(data, &p) != nil || math.IsNaN(p.Lat) || math.Abs(p.Lat) > 90 || math.Abs(p.Lon) > 180 {
			continue
		}
		positionsReceived.Inc()
		began := time.Now()
		if err := t.update(ctx, p); err != nil {
			h.log.Warn("posição não gravada", "courier", id, "err", err)
		}
		positionUpdate.Observe(time.Since(began).Seconds())
	}
}

type tracker struct {
	hub      *Hub
	id       int64
	target   map[string]string
	fetched  time.Time
	wrote    time.Time
	planned  string
	path     [][2]float64
	anchor   Point
	anchorAt time.Time
	offCount int
}

// adopt troca o alvo local pelo do cache só se a leitura em bloco começou depois da última
// escrita deste rastreio no alvo: uma leitura mais velha traria a flag de parado ou desvio
// ainda sem gravar, e o evento sairia duas vezes.
func (t *tracker) adopt() {
	c, ok := t.hub.cachedTarget(t.id)
	if !ok || !c.read.After(t.fetched) || !c.read.After(t.wrote) {
		return
	}
	t.target = maps.Clone(c.fields)
	if t.target == nil {
		t.target = map[string]string{}
	}
	t.fetched = c.read
}

func (t *tracker) update(ctx context.Context, p Point) error {
	now := time.Now()
	t.adopt()
	if t.target == nil {
		t.target = map[string]string{}
	}
	pos := position{Courier: t.id, Lat: p.Lat, Lon: p.Lon, At: now.UnixMilli()}
	w := write{}
	if order, err := strconv.ParseInt(t.target["order_id"], 10, 64); err == nil && order > 0 {
		pos.Order, pos.Phase = order, t.target["phase"]
		lat, _ := strconv.ParseFloat(t.target["lat"], 64)
		lon, _ := strconv.ParseFloat(t.target["lon"], 64)
		if t.target["arrived_"+pos.Phase] == "" && Distance(p, Point{lat, lon}) <= arrivalMeters {
			if err := t.arrive(ctx, order, pos.Phase); err != nil {
				return err
			}
		}
		if key := t.target["order_id"] + ":" + pos.Phase; key != t.planned {
			t.planned = key
			t.path = t.plan(ctx, order, pos.Phase, p, Point{lat, lon})
			t.anchorAt, t.offCount = time.Time{}, 0
		}
		if t.target["arrived_"+pos.Phase] == "" {
			if err := t.watch(ctx, order, pos.Phase, p, now); err != nil {
				return err
			}
		}
		w.track = TrackKey(order, pos.Phase)
		w.point = strconv.FormatFloat(p.Lon, 'f', 6, 64) + "," + strconv.FormatFloat(p.Lat, 'f', 6, 64) + "," + strconv.FormatInt(now.UnixMilli(), 10)
	} else {
		t.planned = ""
	}
	w.pos = pos
	// Fila cheia segura a leitura do WebSocket em vez de descartar: sobrecarga aparece como
	// atraso medido, não como posição perdida em silêncio.
	select {
	case t.hub.writes <- w:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (t *tracker) plan(ctx context.Context, order int64, phase string, from, to Point) [][2]float64 {
	key := PlanKey(order)
	if stored, err := t.hub.rdb.HGet(ctx, key, phase).Result(); err == nil {
		var p Plan
		if json.Unmarshal([]byte(stored), &p) == nil {
			return p.Path
		}
	}
	if t.hub.planner == nil {
		return nil
	}
	plan, ok := t.hub.planner(from, to)
	if !ok {
		return nil
	}
	plan.From, plan.At = [2]float64{from.Lon, from.Lat}, time.Now().UnixMilli()
	data, err := json.Marshal(plan)
	if err != nil {
		return plan.Path
	}
	if err := t.hub.rdb.HSetNX(ctx, key, phase, data).Err(); err != nil {
		t.hub.log.Warn("rota prevista não gravada", "order", order, "err", err)
		return plan.Path
	}
	t.hub.rdb.Expire(ctx, key, journeyTTL)
	return plan.Path
}

func (t *tracker) watch(ctx context.Context, order int64, phase string, p Point, now time.Time) error {
	if t.anchorAt.IsZero() || Distance(p, t.anchor) > stopMeters {
		t.anchor, t.anchorAt = p, now
		if t.target["stopped"] != "" {
			if err := t.flag(ctx, "stopped", false); err != nil {
				return err
			}
			if err := t.emit(ctx, "entregador_em_movimento", order, phase, nil); err != nil {
				return err
			}
		}
	} else if still := now.Sub(t.anchorAt); still >= t.hub.stoppedAfter && t.target["stopped"] == "" {
		if err := t.flag(ctx, "stopped", true); err != nil {
			return err
		}
		if err := t.emit(ctx, "entregador_parado", order, phase, map[string]any{"seconds": int(still.Seconds())}); err != nil {
			return err
		}
	}
	if len(t.path) < 2 {
		return nil
	}
	d := DistanceToPath(p, t.path)
	if d > offRouteMeters {
		t.offCount++
	} else {
		t.offCount = 0
	}
	off := t.target["off_route"] != ""
	switch {
	case !off && t.offCount >= offRouteSamples:
		if err := t.flag(ctx, "off_route", true); err != nil {
			return err
		}
		return t.emit(ctx, "desvio_de_rota", order, phase, map[string]any{"meters": math.Round(d)})
	case off && d <= backOnRoute:
		if err := t.flag(ctx, "off_route", false); err != nil {
			return err
		}
		return t.emit(ctx, "rota_retomada", order, phase, nil)
	}
	return nil
}

func (t *tracker) flag(ctx context.Context, field string, on bool) error {
	var err error
	if on {
		t.target[field] = "1"
		err = t.hub.rdb.HSet(ctx, TargetKey(t.id), field, 1).Err()
	} else {
		delete(t.target, field)
		err = t.hub.rdb.HDel(ctx, TargetKey(t.id), field).Err()
	}
	t.wrote = time.Now()
	return err
}

func (t *tracker) emit(ctx context.Context, kind string, order int64, phase string, extra map[string]any) error {
	data := map[string]any{"order_id": order, "courier_id": t.id, "phase": phase}
	for k, v := range extra {
		data[k] = v
	}
	raw, _ := json.Marshal(data)
	return t.hub.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: TrackingStream,
		MaxLen: streamMax,
		Approx: true,
		Values: map[string]any{"type": kind, "data": string(raw)},
	}).Err()
}

func DistanceToPath(p Point, path [][2]float64) float64 {
	const earth = 6_371_000.0
	ky := earth * math.Pi / 180
	kx := ky * math.Cos(p.Lat*math.Pi/180)
	best := math.Inf(1)
	var ax, ay float64
	for i, c := range path {
		bx, by := (c[0]-p.Lon)*kx, (c[1]-p.Lat)*ky
		if i == 0 {
			best = math.Hypot(bx, by)
		} else {
			best = min(best, toSegment(ax, ay, bx, by))
		}
		ax, ay = bx, by
	}
	return best
}

func toSegment(ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	f := 0.0
	if l := dx*dx + dy*dy; l > 0 {
		f = max(0, min(1, -(ax*dx+ay*dy)/l))
	}
	return math.Hypot(ax+f*dx, ay+f*dy)
}

func (t *tracker) arrive(ctx context.Context, order int64, phase string) error {
	types := map[string]string{"loja": "entregador_chegou_na_loja", "cliente": "entregador_chegou_no_cliente"}
	kind, ok := types[phase]
	if !ok {
		return nil
	}
	first, err := t.hub.rdb.HSetNX(ctx, TargetKey(t.id), "arrived_"+phase, time.Now().UnixMilli()).Result()
	t.wrote = time.Now()
	if err != nil || !first {
		return err
	}
	t.target["arrived_"+phase] = "1"
	return t.emit(ctx, kind, order, phase, nil)
}

func (h *Hub) ServeCentral(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	connected := wsConnections.WithLabelValues("central")
	connected.Inc()
	defer connected.Dec()
	ch := make(chan []byte, 4)
	h.mu.Lock()
	h.central[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.central, ch)
		h.mu.Unlock()
	}()
	if err := conn.Write(r.Context(), websocket.MessageText, h.snapshot()); err != nil {
		return
	}
	h.pump(r.Context(), conn, ch)
}

func (h *Hub) ServeOrder(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "pedido inválido", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	connected := wsConnections.WithLabelValues("order")
	connected.Inc()
	defer connected.Dec()
	ch := make(chan []byte, 16)
	h.mu.Lock()
	if h.watchers[id] == nil {
		h.watchers[id] = map[chan []byte]struct{}{}
	}
	h.watchers[id][ch] = struct{}{}
	var state []byte
	if o, ok := h.orders[id]; ok {
		state, _ = json.Marshal(map[string]any{"type": "estado", "order": o})
	}
	var last []byte
	if o, ok := h.orders[id]; ok && o.Courier != 0 {
		if c, ok := h.couriers[o.Courier]; ok {
			last, _ = json.Marshal(map[string]any{"type": "posicao", "courier_id": o.Courier, "lat": c.pos.Lat, "lon": c.pos.Lon, "phase": c.pos.Phase})
		}
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.watchers[id], ch)
		if len(h.watchers[id]) == 0 {
			delete(h.watchers, id)
		}
		h.mu.Unlock()
	}()
	for _, msg := range [][]byte{state, last} {
		if msg != nil {
			if err := conn.Write(r.Context(), websocket.MessageText, msg); err != nil {
				return
			}
		}
	}
	h.pump(r.Context(), conn, ch)
}

func (h *Hub) pump(ctx context.Context, conn *websocket.Conn, ch chan []byte) {
	ctx = conn.CloseRead(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-ch:
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (h *Hub) Positions(ctx context.Context, ids []int64) (map[int64]Point, error) {
	pipe := h.rdb.Pipeline()
	cmds := make([]*redis.SliceCmd, len(ids))
	for i, id := range ids {
		cmds[i] = pipe.HMGet(ctx, CourierKey(id), "lat", "lon")
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	out := map[int64]Point{}
	for i, cmd := range cmds {
		vals, err := cmd.Result()
		if err != nil || len(vals) != 2 || vals[0] == nil || vals[1] == nil {
			continue
		}
		lat, err1 := strconv.ParseFloat(vals[0].(string), 64)
		lon, err2 := strconv.ParseFloat(vals[1].(string), 64)
		if err1 == nil && err2 == nil {
			out[ids[i]] = Point{lat, lon}
		}
	}
	return out, nil
}

func parseTrack(points []string) [][3]float64 {
	out := make([][3]float64, 0, len(points))
	for _, raw := range points {
		parts := strings.Split(raw, ",")
		if len(parts) != 3 {
			continue
		}
		var v [3]float64
		ok := true
		for i, part := range parts {
			f, err := strconv.ParseFloat(part, 64)
			if err != nil {
				ok = false
				break
			}
			v[i] = f
		}
		if ok {
			out = append(out, v)
		}
	}
	return out
}

func (h *Hub) ServeJourney(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "pedido inválido", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	raw, err := h.rdb.HGetAll(ctx, PlanKey(id)).Result()
	if err != nil {
		http.Error(w, "redis indisponível", http.StatusServiceUnavailable)
		return
	}
	plans := map[string]Plan{}
	for phase, data := range raw {
		var p Plan
		if json.Unmarshal([]byte(data), &p) == nil {
			plans[phase] = p
		}
	}
	tracks := map[string][][3]float64{}
	for _, phase := range []string{"loja", "cliente"} {
		points, err := h.rdb.LRange(ctx, TrackKey(id, phase), 0, -1).Result()
		if err == nil && len(points) > 0 {
			tracks[phase] = parseTrack(points)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"order_id": id, "plan": plans, "track": tracks})
}
