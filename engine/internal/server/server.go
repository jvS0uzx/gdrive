package server

import (
	"cmp"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"slices"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
	"github.com/jvS0uzx/gdrive/engine/internal/live"
	"github.com/jvS0uzx/gdrive/engine/internal/route"
)

const (
	rainFactor    = 1.4
	maxSnapMeters = 400.0
	maxBodyBytes  = 1 << 16
)

type Server struct {
	city      *city.City
	graph     *route.Graph
	geojson   []byte
	meta      []byte
	addresses []byte
	hub       *live.Hub
	log       *slog.Logger
}

type point struct {
	Lat *float64 `json:"lat"`
	Lon *float64 `json:"lon"`
}

type routeRequest struct {
	From point `json:"from"`
	To   point `json:"to"`
	Rain bool  `json:"rain"`
}

type lineString struct {
	Type        string       `json:"type"`
	Coordinates [][2]float64 `json:"coordinates"`
}

type road struct {
	Name   string  `json:"name"`
	Meters float64 `json:"meters"`
}

type routeResponse struct {
	FromNode          int32      `json:"from_node"`
	ToNode            int32      `json:"to_node"`
	Seconds           float64    `json:"seconds"`
	Meters            float64    `json:"meters"`
	Rain              bool       `json:"rain"`
	Roads             []road     `json:"roads"`
	Path              lineString `json:"path"`
	CumulativeSeconds []float64  `json:"cumulative_seconds"`
}

type place struct {
	Node int32   `json:"node"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	Name string  `json:"name,omitempty"`
}

func addressesOf(c *city.City) ([]byte, error) {
	groups := map[string][]place{"stores": {}, "courier_homes": {}, "customers": {}}
	keys := map[city.AddressKind]string{city.Store: "stores", city.CourierHome: "courier_homes", city.Customer: "customers"}
	for _, a := range c.Addresses {
		lat, lon := c.LatLon(a.Node)
		groups[keys[a.Kind]] = append(groups[keys[a.Kind]], place{Node: a.Node, Lat: round6(lat), Lon: round6(lon), Name: a.Name})
	}
	return json.Marshal(groups)
}

func round6(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

func New(c *city.City, g *route.Graph, hub *live.Hub, log *slog.Logger) (*Server, error) {
	geojson, err := c.GeoJSON()
	if err != nil {
		return nil, err
	}
	speeds := map[string]float64{}
	for _, cl := range city.Classes {
		speeds[cl.String()] = cl.DefaultKMH()
	}
	degree := make([]int, len(c.Nodes))
	var meters float64
	for _, st := range c.Streets {
		degree[st.From]++
		degree[st.To]++
		meters += st.Meters
	}
	junctions := 0
	for _, d := range degree {
		if d >= 3 {
			junctions++
		}
	}
	meta, err := json.Marshal(map[string]any{
		"name":        c.Name,
		"source":      c.Source,
		"nodes":       len(c.Nodes),
		"junctions":   junctions,
		"streets":     len(c.Streets),
		"km":          math.Round(meters / 1000),
		"bbox":        c.Bounds(),
		"speeds_kmh":  speeds,
		"rain_factor": rainFactor,
	})
	if err != nil {
		return nil, err
	}
	addresses, err := addressesOf(c)
	if err != nil {
		return nil, err
	}
	return &Server{city: c, graph: g, geojson: geojson, meta: meta, addresses: addresses, hub: hub, log: log}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /city", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(s.meta)
	})
	mux.HandleFunc("GET /city.geojson", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/geo+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Write(s.geojson)
	})
	mux.HandleFunc("GET /city/addresses", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(s.addresses)
	})
	mux.HandleFunc("POST /route", s.route)
	mux.HandleFunc("POST /route/alternatives", s.alternatives)
	if s.hub != nil {
		mux.HandleFunc("POST /eta", s.eta)
		mux.HandleFunc("GET /ws/courier", s.hub.ServeCourier)
		mux.HandleFunc("GET /ws/watch/central", s.hub.ServeCentral)
		mux.HandleFunc("GET /ws/watch/order/{id}", s.hub.ServeOrder)
		mux.HandleFunc("GET /journey/{id}", s.hub.ServeJourney)
	}
	return mux
}

func (s *Server) snap(p point) (int32, error) {
	if p.Lat == nil || p.Lon == nil {
		return 0, errors.New("lat e lon são obrigatórios")
	}
	lat, lon := *p.Lat, *p.Lon
	if math.IsNaN(lat) || math.IsNaN(lon) || math.Abs(lat) > 90 || math.Abs(lon) > 180 {
		return 0, errors.New("coordenada inválida")
	}
	x, y := s.city.ToXY(lat, lon)
	node, dist := s.graph.Nearest(x, y)
	if node < 0 || dist > maxSnapMeters {
		return 0, errOutside
	}
	return node, nil
}

var errOutside = errors.New("ponto fora da cidade")

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req routeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "json inválido")
		return
	}
	from, err := s.snap(req.From)
	if err != nil {
		writeError(w, statusOf(err), "origem: "+err.Error())
		return
	}
	to, err := s.snap(req.To)
	if err != nil {
		writeError(w, statusOf(err), "destino: "+err.Error())
		return
	}
	factor, rain := s.weather(req.Rain)
	p, ok := s.graph.Shortest(from, to, factor)
	if !ok {
		s.log.Error("rota impossível numa malha que deveria ser fortemente conexa", "from", from, "to", to)
		writeError(w, http.StatusUnprocessableEntity, "não existe rota entre os dois pontos")
		return
	}
	resp := routeResponse{
		FromNode:          from,
		ToNode:            to,
		Seconds:           round1(p.Seconds),
		Meters:            round1(p.Meters),
		Rain:              rain,
		Roads:             s.mainRoads(p.Streets),
		Path:              lineString{Type: "LineString", Coordinates: make([][2]float64, len(p.Nodes))},
		CumulativeSeconds: make([]float64, len(p.Cumulative)),
	}
	for i, n := range p.Nodes {
		resp.Path.Coordinates[i] = s.city.Point(n)
		resp.CumulativeSeconds[i] = round1(p.Cumulative[i])
	}
	writeJSON(w, http.StatusOK, resp)
}

type routeOption struct {
	Seconds float64    `json:"seconds"`
	Meters  float64    `json:"meters"`
	Roads   []road     `json:"roads"`
	Path    lineString `json:"path"`
}

func (s *Server) option(p route.Path) *routeOption {
	o := &routeOption{
		Seconds: round1(p.Seconds),
		Meters:  round1(p.Meters),
		Roads:   s.mainRoads(p.Streets),
		Path:    lineString{Type: "LineString", Coordinates: make([][2]float64, len(p.Nodes))},
	}
	for i, n := range p.Nodes {
		o.Path.Coordinates[i] = s.city.Point(n)
	}
	return o
}

func (s *Server) alternatives(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req routeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "json inválido")
		return
	}
	from, err := s.snap(req.From)
	if err != nil {
		writeError(w, statusOf(err), "origem: "+err.Error())
		return
	}
	to, err := s.snap(req.To)
	if err != nil {
		writeError(w, statusOf(err), "destino: "+err.Error())
		return
	}
	factor, _ := s.weather(req.Rain)
	out := map[string]*routeOption{}
	for name, mode := range map[string]route.Mode{"fastest": route.Fastest, "shortest": route.Shortest, "no_expressway": route.NoExpressway} {
		if p, ok := s.graph.ShortestBy(from, to, factor, mode); ok {
			out[name] = s.option(p)
		} else {
			out[name] = nil
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) Plan(from, to live.Point) (live.Plan, bool) {
	fx, fy := s.city.ToXY(from.Lat, from.Lon)
	tx, ty := s.city.ToXY(to.Lat, to.Lon)
	a, da := s.graph.Nearest(fx, fy)
	b, db := s.graph.Nearest(tx, ty)
	if a < 0 || b < 0 || da > maxSnapMeters || db > maxSnapMeters {
		return live.Plan{}, false
	}
	factor, _ := s.weather(false)
	p, ok := s.graph.Shortest(a, b, factor)
	if !ok {
		return live.Plan{}, false
	}
	plan := live.Plan{Seconds: round1(p.Seconds), Meters: round1(p.Meters), Path: make([][2]float64, len(p.Nodes))}
	for i, n := range p.Nodes {
		plan.Path[i] = s.city.Point(n)
	}
	return plan, true
}

type etaRequest struct {
	To       point   `json:"to"`
	Couriers []int64 `json:"couriers"`
	Rain     bool    `json:"rain"`
}

type eta struct {
	Courier int64   `json:"courier_id"`
	Seconds float64 `json:"seconds"`
}

func (s *Server) eta(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req etaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Couriers) > 2000 {
		writeError(w, http.StatusBadRequest, "json inválido")
		return
	}
	target, err := s.snap(req.To)
	if err != nil {
		writeError(w, statusOf(err), "destino: "+err.Error())
		return
	}
	positions, err := s.hub.Positions(r.Context(), req.Couriers)
	if err != nil {
		s.log.Error("posições no redis", "err", err)
		writeError(w, http.StatusServiceUnavailable, "posições indisponíveis")
		return
	}
	var ids []int64
	var nodes []int32
	for _, id := range req.Couriers {
		p, ok := positions[id]
		if !ok {
			continue
		}
		x, y := s.city.ToXY(p.Lat, p.Lon)
		node, dist := s.graph.Nearest(x, y)
		if node < 0 || dist > maxSnapMeters {
			continue
		}
		ids = append(ids, id)
		nodes = append(nodes, node)
	}
	factor, _ := s.weather(req.Rain)
	times := s.graph.TimesTo(target, nodes, factor)
	out := make([]eta, 0, len(ids))
	for i, id := range ids {
		if !math.IsInf(times[i], 1) {
			out = append(out, eta{id, round1(times[i])})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"etas": out})
}

func (s *Server) weather(asked bool) (float64, bool) {
	if asked || (s.hub != nil && s.hub.Raining()) {
		return rainFactor, true
	}
	return 1, false
}

func (s *Server) mainRoads(streets []int32) []road {
	type total struct {
		road
		first int
	}
	var totals []total
	at := map[string]int{}
	for i, si := range streets {
		st := s.city.Streets[si]
		name := s.city.Ways[st.Way].Name
		if name == "" {
			continue
		}
		k, ok := at[name]
		if !ok {
			k = len(totals)
			at[name] = k
			totals = append(totals, total{road{name, 0}, i})
		}
		totals[k].Meters += st.Meters
	}
	kept := totals[:0]
	for _, t := range totals {
		if t.Meters >= 150 {
			kept = append(kept, t)
		}
	}
	slices.SortStableFunc(kept, func(a, b total) int { return cmp.Compare(b.Meters, a.Meters) })
	kept = kept[:min(len(kept), 4)]
	slices.SortFunc(kept, func(a, b total) int { return cmp.Compare(a.first, b.first) })
	out := make([]road, len(kept))
	for i, t := range kept {
		out[i] = road{t.Name, math.Round(t.Meters)}
	}
	return out
}

func statusOf(err error) int {
	if errors.Is(err, errOutside) {
		return http.StatusUnprocessableEntity
	}
	return http.StatusBadRequest
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
