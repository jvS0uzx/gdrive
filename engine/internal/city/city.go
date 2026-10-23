package city

import (
	"bytes"
	"compress/gzip"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

const (
	metersPerDegreeLat = 110_574.0
	metersPerDegreeLon = 111_320.0
)

type Class uint8

const (
	ClassExpressway Class = iota
	ClassAvenue
	ClassCollector
	ClassStreet
	ClassLane
)

var Classes = []Class{ClassExpressway, ClassAvenue, ClassCollector, ClassStreet, ClassLane}

func (c Class) String() string {
	switch c {
	case ClassExpressway:
		return "expressa"
	case ClassAvenue:
		return "avenida"
	case ClassCollector:
		return "coletora"
	case ClassStreet:
		return "rua"
	case ClassLane:
		return "travessa"
	}
	return "desconhecida"
}

func (c Class) DefaultKMH() float64 {
	switch c {
	case ClassExpressway:
		return 80
	case ClassAvenue:
		return 60
	case ClassCollector:
		return 50
	case ClassStreet:
		return 40
	default:
		return 30
	}
}

type Node struct {
	X, Y float64
}

type Street struct {
	From, To int32
	Meters   float64
	SpeedKMH float64
	Class    Class
	OneWay   bool
	Way      int32
}

func (s Street) SpeedMS() float64 {
	return s.SpeedKMH / 3.6
}

type Way struct {
	Name   string
	Class  Class
	OneWay bool
	Nodes  []int32
}

type AddressKind uint8

const (
	Customer AddressKind = iota
	Store
	CourierHome
)

func (k AddressKind) String() string {
	switch k {
	case Customer:
		return "customer"
	case Store:
		return "store"
	case CourierHome:
		return "courier_home"
	}
	return "unknown"
}

type Address struct {
	Node int32
	Kind AddressKind
	Name string
}

type City struct {
	Name      string
	Source    string
	OriginLat float64
	OriginLon float64
	Nodes     []Node
	Streets   []Street
	Ways      []Way
	Addresses []Address
}

func (c *City) lonScale() float64 {
	return metersPerDegreeLon * math.Cos(c.OriginLat*math.Pi/180)
}

func (c *City) ToXY(lat, lon float64) (x, y float64) {
	return (lon - c.OriginLon) * c.lonScale(), (lat - c.OriginLat) * metersPerDegreeLat
}

func (c *City) ToLatLon(x, y float64) (lat, lon float64) {
	return c.OriginLat + y/metersPerDegreeLat, c.OriginLon + x/c.lonScale()
}

func Distance(a, b Node) float64 {
	return math.Hypot(a.X-b.X, a.Y-b.Y)
}

func (c *City) LatLon(i int32) (lat, lon float64) {
	n := c.Nodes[i]
	return c.ToLatLon(n.X, n.Y)
}

func (c *City) Bounds() [4]float64 {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, n := range c.Nodes {
		minX, maxX = math.Min(minX, n.X), math.Max(maxX, n.X)
		minY, maxY = math.Min(minY, n.Y), math.Max(maxY, n.Y)
	}
	minLat, minLon := c.ToLatLon(minX, minY)
	maxLat, maxLon := c.ToLatLon(maxX, maxY)
	return [4]float64{minLon, minLat, maxLon, maxLat}
}

func (c *City) Save(path string) error {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(zw).Encode(c); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func Load(path string) (*City, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	var c City
	if err := gob.NewDecoder(zr).Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}

type geometry struct {
	Type        string       `json:"type"`
	Coordinates [][2]float64 `json:"coordinates"`
}

type feature struct {
	Type       string         `json:"type"`
	Geometry   geometry       `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

type featureCollection struct {
	Type     string     `json:"type"`
	BBox     [4]float64 `json:"bbox"`
	Features []feature  `json:"features"`
}

func round6(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

func (c *City) Point(i int32) [2]float64 {
	lat, lon := c.LatLon(i)
	return [2]float64{round6(lon), round6(lat)}
}

func (c *City) GeoJSON() ([]byte, error) {
	fc := featureCollection{Type: "FeatureCollection", BBox: c.Bounds(), Features: make([]feature, 0, len(c.Ways))}
	for _, w := range c.Ways {
		coords := make([][2]float64, len(w.Nodes))
		for i, n := range w.Nodes {
			coords[i] = c.Point(n)
		}
		props := map[string]any{"class": w.Class.String(), "oneway": w.OneWay}
		if w.Name != "" {
			props["name"] = w.Name
		}
		fc.Features = append(fc.Features, feature{
			Type:       "Feature",
			Geometry:   geometry{Type: "LineString", Coordinates: coords},
			Properties: props,
		})
	}
	return json.Marshal(fc)
}
