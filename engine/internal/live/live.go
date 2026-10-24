package live

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
)

const (
	GeoKey          = "geo:couriers"
	PositionsTopic  = "live:positions"
	OrdersStream    = "events.orders"
	TrackingStream  = "events.tracking"
	arrivalMeters   = 50.0
	snapshotEvery   = 500 * time.Millisecond
	targetFreshness = 2 * time.Second
	replayEntries   = 20000
)

func CourierKey(id int64) string { return "courier:" + strconv.FormatInt(id, 10) }
func TargetKey(id int64) string  { return "target:" + strconv.FormatInt(id, 10) }

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
}

type orderState struct {
	ID       int64  `json:"id"`
	Status   string `json:"status"`
	Version  int    `json:"version"`
	Store    *Point `json:"store,omitempty"`
	Customer *Point `json:"customer,omitempty"`
	Name     string `json:"store_name,omitempty"`
	Courier  int64  `json:"courier_id,omitempty"`
}

type courierState struct {
	pos  position
	seen time.Time
}

var finished = map[string]bool{"entregue": true, "cancelado": true, "recusado": true}

type Hub struct {
	rdb      *redis.Client
	log      *slog.Logger
	mu       sync.RWMutex
	couriers map[int64]*courierState
	orders   map[int64]*orderState
	central  map[chan []byte]struct{}
	watchers map[int64]map[chan []byte]struct{}
}

func New(rdb *redis.Client, log *slog.Logger) *Hub {
	return &Hub{
		rdb:      rdb,
		log:      log,
		couriers: map[int64]*courierState{},
		orders:   map[int64]*orderState{},
		central:  map[chan []byte]struct{}{},
		watchers: map[int64]map[chan []byte]struct{}{},
	}
}

func (h *Hub) Run(ctx context.Context) {
	go h.followPositions(ctx)
	go h.followOrders(ctx)
	go h.broadcastSnapshots(ctx)
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
		var p position
		if err := json.Unmarshal([]byte(msg.Payload), &p); err != nil {
			continue
		}
		h.mu.Lock()
		h.couriers[p.Courier] = &courierState{pos: p, seen: time.Now()}
		h.mu.Unlock()
		if p.Order != 0 {
			data, _ := json.Marshal(map[string]any{"type": "posicao", "courier_id": p.Courier, "lat": p.Lat, "lon": p.Lon, "phase": p.Phase})
			h.toWatchers(p.Order, data)
		}
	}
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
			o.Store, o.Name = e.Store, e.Name
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

func (h *Hub) snapshot() []byte {
	h.mu.RLock()
	defer h.mu.RUnlock()
	couriers := make([][4]float64, 0, len(h.couriers))
	for id, c := range h.couriers {
		busy := 0.0
		if c.pos.Order != 0 {
			busy = 1
		}
		couriers = append(couriers, [4]float64{float64(id), c.pos.Lon, c.pos.Lat, busy})
	}
	orders := make([]*orderState, 0)
	for _, o := range h.orders {
		if !finished[o.Status] && o.Store != nil {
			orders = append(orders, o)
		}
	}
	data, _ := json.Marshal(map[string]any{"type": "snapshot", "couriers": couriers, "orders": orders})
	return data
}

func (h *Hub) broadcastSnapshots(ctx context.Context) {
	tick := time.NewTicker(snapshotEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		h.mu.RLock()
		n := len(h.central)
		h.mu.RUnlock()
		if n == 0 {
			continue
		}
		data := h.snapshot()
		h.mu.RLock()
		for ch := range h.central {
			select {
			case ch <- data:
			default:
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
	ctx := r.Context()
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
		if err := t.update(ctx, p); err != nil {
			h.log.Warn("posição não gravada", "courier", id, "err", err)
		}
	}
}

type tracker struct {
	hub     *Hub
	id      int64
	target  map[string]string
	fetched time.Time
}

func (t *tracker) update(ctx context.Context, p Point) error {
	rdb := t.hub.rdb
	now := time.Now()
	if now.Sub(t.fetched) > targetFreshness {
		target, err := rdb.HGetAll(ctx, TargetKey(t.id)).Result()
		if err != nil {
			return err
		}
		t.target, t.fetched = target, now
	}
	pos := position{Courier: t.id, Lat: p.Lat, Lon: p.Lon, At: now.UnixMilli()}
	pipe := rdb.Pipeline()
	pipe.GeoAdd(ctx, GeoKey, &redis.GeoLocation{Name: strconv.FormatInt(t.id, 10), Longitude: p.Lon, Latitude: p.Lat})
	pipe.HSet(ctx, CourierKey(t.id), "lat", p.Lat, "lon", p.Lon, "ts", now.UnixMilli())
	if order, err := strconv.ParseInt(t.target["order_id"], 10, 64); err == nil && order > 0 {
		pos.Order, pos.Phase = order, t.target["phase"]
		lat, _ := strconv.ParseFloat(t.target["lat"], 64)
		lon, _ := strconv.ParseFloat(t.target["lon"], 64)
		if t.target["arrived_"+pos.Phase] == "" && Distance(p, Point{lat, lon}) <= arrivalMeters {
			if err := t.arrive(ctx, order, pos.Phase); err != nil {
				return err
			}
		}
	}
	data, _ := json.Marshal(pos)
	pipe.Publish(ctx, PositionsTopic, data)
	_, err := pipe.Exec(ctx)
	return err
}

func (t *tracker) arrive(ctx context.Context, order int64, phase string) error {
	types := map[string]string{"loja": "entregador_chegou_na_loja", "cliente": "entregador_chegou_no_cliente"}
	kind, ok := types[phase]
	if !ok {
		return nil
	}
	rdb := t.hub.rdb
	first, err := rdb.HSetNX(ctx, TargetKey(t.id), "arrived_"+phase, time.Now().UnixMilli()).Result()
	if err != nil || !first {
		return err
	}
	t.target["arrived_"+phase] = "1"
	data, _ := json.Marshal(map[string]any{"order_id": order, "courier_id": t.id, "phase": phase})
	return rdb.XAdd(ctx, &redis.XAddArgs{Stream: TrackingStream, Values: map[string]any{"type": kind, "data": string(data)}}).Err()
}

func (h *Hub) ServeCentral(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
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
