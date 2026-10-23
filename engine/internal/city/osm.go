package city

import (
	"cmp"
	"encoding/json"
	"io"
	"math"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
)

const (
	storeSnapMeters = 150.0
	placeCell       = 200.0
)

type Report struct {
	Ways         int
	SkippedWays  int
	RawNodes     int
	DroppedNodes int
	OneWayWays   int
	Roundabouts  int
	TaggedSpeed  int
	Places       int
}

type osmElement struct {
	Type   string            `json:"type"`
	ID     int64             `json:"id"`
	Lat    float64           `json:"lat"`
	Lon    float64           `json:"lon"`
	Nodes  []int64           `json:"nodes"`
	Tags   map[string]string `json:"tags"`
	Center *struct {
		Lat float64 `json:"lat"`
		Lon float64 `json:"lon"`
	} `json:"center"`
}

type osmDoc struct {
	OSM3S struct {
		Base string `json:"timestamp_osm_base"`
	} `json:"osm3s"`
	Elements []osmElement `json:"elements"`
}

var highwayClass = map[string]Class{
	"motorway":       ClassExpressway,
	"motorway_link":  ClassExpressway,
	"trunk":          ClassExpressway,
	"trunk_link":     ClassExpressway,
	"primary":        ClassAvenue,
	"primary_link":   ClassAvenue,
	"secondary":      ClassCollector,
	"secondary_link": ClassCollector,
	"tertiary":       ClassCollector,
	"tertiary_link":  ClassCollector,
	"residential":    ClassStreet,
	"unclassified":   ClassStreet,
	"living_street":  ClassLane,
}

var storeAmenities = map[string]bool{"restaurant": true, "fast_food": true, "cafe": true, "ice_cream": true}

func blocked(tags map[string]string) bool {
	if tags["area"] == "yes" {
		return true
	}
	if v := tags["oneway"]; v == "alternating" || v == "reversible" {
		return true
	}
	for _, k := range []string{"motorcycle", "motor_vehicle", "vehicle", "access"} {
		if v, ok := tags[k]; ok {
			return v == "no" || v == "private"
		}
	}
	return false
}

func direction(tags map[string]string) (oneWay, reverse bool) {
	switch tags["oneway"] {
	case "yes", "true", "1":
		return true, false
	case "-1", "reverse":
		return true, true
	case "no", "false", "0":
		return false, false
	}
	if j := tags["junction"]; j == "roundabout" || j == "circular" {
		return true, false
	}
	if h := tags["highway"]; h == "motorway" || h == "motorway_link" {
		return true, false
	}
	return false, false
}

func speedOf(tags map[string]string, class Class) (float64, bool) {
	v := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(tags["maxspeed"]), "km/h"))
	if n, err := strconv.ParseFloat(v, 64); err == nil && n >= 5 && n <= 130 {
		return n, true
	}
	return class.DefaultKMH(), false
}

type rawWay struct {
	name   string
	class  Class
	oneWay bool
	speed  float64
	nodes  []int32
}

func FromOverpass(name string, roads, places io.Reader) (*City, Report, error) {
	var report Report
	var doc osmDoc
	if err := json.NewDecoder(roads).Decode(&doc); err != nil {
		return nil, report, err
	}
	coords := map[int64][2]float64{}
	var ways []osmElement
	for _, e := range doc.Elements {
		switch e.Type {
		case "node":
			coords[e.ID] = [2]float64{e.Lat, e.Lon}
		case "way":
			if _, ok := highwayClass[e.Tags["highway"]]; ok {
				ways = append(ways, e)
			}
		}
	}
	slices.SortFunc(ways, func(a, b osmElement) int { return cmp.Compare(a.ID, b.ID) })

	index := map[int64]int32{}
	var lat, lon []float64
	var raws []rawWay
	for _, w := range ways {
		if blocked(w.Tags) {
			report.SkippedWays++
			continue
		}
		class := highwayClass[w.Tags["highway"]]
		oneWay, reverse := direction(w.Tags)
		speed, tagged := speedOf(w.Tags, class)
		var ids []int32
		for _, id := range w.Nodes {
			c, ok := coords[id]
			if !ok {
				continue
			}
			i, seen := index[id]
			if !seen {
				i = int32(len(lat))
				index[id] = i
				lat = append(lat, c[0])
				lon = append(lon, c[1])
			}
			ids = append(ids, i)
		}
		if len(ids) < 2 {
			report.SkippedWays++
			continue
		}
		if reverse {
			slices.Reverse(ids)
		}
		if oneWay {
			report.OneWayWays++
		}
		if j := w.Tags["junction"]; j == "roundabout" || j == "circular" {
			report.Roundabouts++
		}
		if tagged {
			report.TaggedSpeed++
		}
		raws = append(raws, rawWay{name: w.Tags["name"], class: class, oneWay: oneWay, speed: speed, nodes: ids})
	}
	report.Ways = len(raws)
	report.RawNodes = len(lat)

	type pair struct{ a, b int32 }
	seen := map[pair]int{}
	var streets []Street
	for wi, w := range raws {
		for k := 1; k < len(w.nodes); k++ {
			a, b := w.nodes[k-1], w.nodes[k]
			if a == b {
				continue
			}
			key := pair{min(a, b), max(a, b)}
			if j, dup := seen[key]; dup {
				e := &streets[j]
				if w.class < e.Class {
					e.Class, e.SpeedKMH, e.Way = w.class, w.speed, int32(wi)
				}
				if !w.oneWay || e.From != a {
					e.OneWay = false
				}
				continue
			}
			seen[key] = len(streets)
			streets = append(streets, Street{From: a, To: b, SpeedKMH: w.speed, Class: w.class, OneWay: w.oneWay, Way: int32(wi)})
		}
	}

	comp, count := components(len(lat), streets)
	sizes := make([]int, count)
	for _, c := range comp {
		sizes[c]++
	}
	best := int32(0)
	for i, s := range sizes {
		if s > sizes[best] {
			best = int32(i)
		}
	}
	remap := make([]int32, len(lat))
	minLat, maxLat, minLon, maxLon := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	kept := int32(0)
	for i := range lat {
		remap[i] = -1
		if comp[i] == best {
			remap[i] = kept
			kept++
			minLat, maxLat = math.Min(minLat, lat[i]), math.Max(maxLat, lat[i])
			minLon, maxLon = math.Min(minLon, lon[i]), math.Max(maxLon, lon[i])
		}
	}
	report.DroppedNodes = len(lat) - int(kept)

	c := &City{
		Name:      name,
		Source:    "© colaboradores do OpenStreetMap (ODbL), base de " + doc.OSM3S.Base,
		OriginLat: (minLat + maxLat) / 2,
		OriginLon: (minLon + maxLon) / 2,
		Nodes:     make([]Node, kept),
	}
	for i := range lat {
		if remap[i] >= 0 {
			x, y := c.ToXY(lat[i], lon[i])
			c.Nodes[remap[i]] = Node{X: x, Y: y}
		}
	}

	wayOf := map[pair]int32{}
	for wi, w := range raws {
		var run []int32
		flush := func() {
			if len(run) >= 2 {
				c.Ways = append(c.Ways, Way{Name: w.name, Class: w.class, OneWay: w.oneWay, Nodes: run})
			}
			run = nil
		}
		for k, n := range w.nodes {
			r := remap[n]
			if r < 0 {
				flush()
				continue
			}
			if k > 0 && len(run) > 0 {
				key := pair{min(w.nodes[k-1], n), max(w.nodes[k-1], n)}
				if j, ok := seen[key]; ok && streets[j].Way == int32(wi) {
					wayOf[key] = int32(len(c.Ways))
				}
			}
			run = append(run, r)
		}
		flush()
	}
	for _, s := range streets {
		if remap[s.From] < 0 || remap[s.To] < 0 {
			continue
		}
		key := pair{min(s.From, s.To), max(s.From, s.To)}
		s.Way = wayOf[key]
		s.From, s.To = remap[s.From], remap[s.To]
		s.Meters = Distance(c.Nodes[s.From], c.Nodes[s.To])
		c.Streets = append(c.Streets, s)
	}

	if places != nil {
		var pdoc osmDoc
		if err := json.NewDecoder(places).Decode(&pdoc); err != nil {
			return nil, report, err
		}
		c.Addresses = append(c.Addresses, storesFrom(c, pdoc.Elements)...)
	}
	report.Places = len(c.Addresses)
	c.Addresses = append(c.Addresses, homes(c)...)
	return c, report, nil
}

type cellKey struct {
	x, y int
}

func storesFrom(c *City, elements []osmElement) []Address {
	expressway := make([]bool, len(c.Nodes))
	for _, s := range c.Streets {
		if s.Class == ClassExpressway {
			expressway[s.From], expressway[s.To] = true, true
		}
	}
	grid := map[cellKey][]int32{}
	key := func(x, y float64) cellKey {
		return cellKey{int(math.Floor(x / placeCell)), int(math.Floor(y / placeCell))}
	}
	for i, n := range c.Nodes {
		if !expressway[i] {
			k := key(n.X, n.Y)
			grid[k] = append(grid[k], int32(i))
		}
	}
	slices.SortFunc(elements, func(a, b osmElement) int {
		return cmp.Or(cmp.Compare(a.Type, b.Type), cmp.Compare(a.ID, b.ID))
	})
	var out []Address
	for _, e := range elements {
		name := strings.TrimSpace(e.Tags["name"])
		if !storeAmenities[e.Tags["amenity"]] || name == "" {
			continue
		}
		lat, lon := e.Lat, e.Lon
		if e.Center != nil {
			lat, lon = e.Center.Lat, e.Center.Lon
		}
		x, y := c.ToXY(lat, lon)
		k := key(x, y)
		best, bestDist := int32(-1), storeSnapMeters
		for dx := -1; dx <= 1; dx++ {
			for dy := -1; dy <= 1; dy++ {
				for _, i := range grid[cellKey{k.x + dx, k.y + dy}] {
					if d := math.Hypot(c.Nodes[i].X-x, c.Nodes[i].Y-y); d < bestDist {
						best, bestDist = i, d
					}
				}
			}
		}
		if best >= 0 {
			out = append(out, Address{Node: best, Kind: Store, Name: name})
		}
	}
	return out
}

func homes(c *City) []Address {
	residential := make([]bool, len(c.Nodes))
	for _, s := range c.Streets {
		if s.Class >= ClassStreet {
			residential[s.From], residential[s.To] = true, true
		}
	}
	var pool []int32
	for i, ok := range residential {
		if ok {
			pool = append(pool, int32(i))
		}
	}
	rng := rand.New(rand.NewPCG(42, 7))
	rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	couriers := min(3000, len(pool)/20)
	customers := min(20000, len(pool)/3)
	var out []Address
	for i, n := range pool {
		switch {
		case i < couriers:
			out = append(out, Address{Node: n, Kind: CourierHome})
		case i < couriers+customers:
			out = append(out, Address{Node: n, Kind: Customer})
		}
	}
	return out
}
