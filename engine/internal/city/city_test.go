package city

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func repoPath(parts ...string) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(append([]string{filepath.Dir(file), "..", "..", ".."}, parts...)...)
}

type fixtureNode struct {
	id       int64
	lat, lon float64
}

func overpassJSON(nodes []fixtureNode, ways []map[string]any) string {
	elements := append([]map[string]any{}, ways...)
	for _, n := range nodes {
		elements = append(elements, map[string]any{"type": "node", "id": n.id, "lat": n.lat, "lon": n.lon})
	}
	data, _ := json.Marshal(map[string]any{
		"osm3s":    map[string]string{"timestamp_osm_base": "2026-10-23T00:00:00Z"},
		"elements": elements,
	})
	return string(data)
}

func way(id int64, nodes []int64, tags map[string]string) map[string]any {
	return map[string]any{"type": "way", "id": id, "nodes": nodes, "tags": tags}
}

func fixture() (string, map[int64][2]float64) {
	base := [2]float64{-12.97, -38.50}
	nodes := []fixtureNode{
		{1, base[0], base[1]},
		{2, base[0], base[1] + 0.002},
		{3, base[0] + 0.002, base[1] + 0.002},
		{4, base[0] + 0.002, base[1]},
		{5, base[0] - 0.002, base[1]},
		{6, base[0] + 0.004, base[1] + 0.002},
		{7, base[0] + 0.006, base[1] + 0.002},
		{8, base[0] + 0.05, base[1] + 0.05},
		{9, base[0] + 0.05, base[1] + 0.052},
	}
	at := map[int64][2]float64{}
	for _, n := range nodes {
		at[n.id] = [2]float64{n.lat, n.lon}
	}
	ways := []map[string]any{
		way(10, []int64{1, 2}, map[string]string{"highway": "residential", "name": "Rua A", "maxspeed": "30 km/h"}),
		way(11, []int64{2, 3}, map[string]string{"highway": "secondary", "name": "Rua B", "oneway": "yes"}),
		way(12, []int64{4, 3}, map[string]string{"highway": "residential", "name": "Rua C", "oneway": "-1"}),
		way(13, []int64{4, 1}, map[string]string{"highway": "tertiary", "junction": "roundabout"}),
		way(14, []int64{1, 5}, map[string]string{"highway": "residential", "access": "private"}),
		way(15, []int64{3, 6}, map[string]string{"highway": "residential"}),
		way(16, []int64{6, 7}, map[string]string{"highway": "residential", "oneway": "yes"}),
		way(17, []int64{8, 9}, map[string]string{"highway": "motorway"}),
		way(18, []int64{2, 9}, map[string]string{"highway": "footway"}),
	}
	return overpassJSON(nodes, ways), at
}

func nodeAt(t *testing.T, c *City, lat, lon float64) int32 {
	t.Helper()
	x, y := c.ToXY(lat, lon)
	for i, n := range c.Nodes {
		if math.Hypot(n.X-x, n.Y-y) < 0.01 {
			return int32(i)
		}
	}
	return -1
}

func TestImportaSentidoAcessoEComponente(t *testing.T) {
	roads, at := fixture()
	c, report, err := FromOverpass("Teste", strings.NewReader(roads), nil)
	if err != nil {
		t.Fatal(err)
	}
	id := func(osm int64) int32 { return nodeAt(t, c, at[osm][0], at[osm][1]) }
	for _, osm := range []int64{1, 2, 3, 4, 6} {
		if id(osm) < 0 {
			t.Fatalf("nó %d deveria estar na malha", osm)
		}
	}
	for _, osm := range []int64{5, 7, 8, 9} {
		if id(osm) >= 0 {
			t.Fatalf("nó %d não deveria estar na malha", osm)
		}
	}
	if report.SkippedWays != 1 || report.DroppedNodes != 3 || report.Roundabouts != 1 {
		t.Fatalf("relatório inesperado: %+v", report)
	}
	if !c.StronglyConnected() {
		t.Fatal("malha importada não é fortemente conexa")
	}
	find := func(a, b int64) Street {
		for _, s := range c.Streets {
			if (s.From == id(a) && s.To == id(b)) || (s.From == id(b) && s.To == id(a)) {
				return s
			}
		}
		t.Fatalf("trecho %d-%d não existe", a, b)
		return Street{}
	}
	cases := []struct {
		a, b     int64
		oneWay   bool
		from     int64
		speedKMH float64
	}{
		{1, 2, false, 0, 30},
		{2, 3, true, 2, ClassCollector.DefaultKMH()},
		{4, 3, true, 3, ClassStreet.DefaultKMH()},
		{4, 1, true, 4, ClassCollector.DefaultKMH()},
		{3, 6, false, 0, ClassStreet.DefaultKMH()},
	}
	for _, tc := range cases {
		s := find(tc.a, tc.b)
		if s.OneWay != tc.oneWay {
			t.Errorf("%d-%d: mão única %v, esperado %v", tc.a, tc.b, s.OneWay, tc.oneWay)
		}
		if tc.oneWay && s.From != id(tc.from) {
			t.Errorf("%d-%d: sentido errado, sai de %d", tc.a, tc.b, s.From)
		}
		if s.SpeedKMH != tc.speedKMH {
			t.Errorf("%d-%d: %.0f km/h, esperado %.0f", tc.a, tc.b, s.SpeedKMH, tc.speedKMH)
		}
		if s.Meters < 100 || s.Meters > 400 {
			t.Errorf("%d-%d: %.1f m", tc.a, tc.b, s.Meters)
		}
	}
	if w := c.Ways[find(1, 2).Way]; w.Name != "Rua A" {
		t.Errorf("trecho 1-2 aponta para a via %q", w.Name)
	}
	if w := c.Ways[find(4, 3).Way]; w.Name != "Rua C" || w.Nodes[0] != id(3) {
		t.Errorf("via de mão única invertida deveria começar no nó 3: %+v", w)
	}
}

func TestGeoJSONDesenhaCadaViaNoSentidoDoTrafego(t *testing.T) {
	roads, at := fixture()
	c, _, err := FromOverpass("Teste", strings.NewReader(roads), nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := c.GeoJSON()
	if err != nil {
		t.Fatal(err)
	}
	var fc struct {
		Features []struct {
			Geometry struct {
				Coordinates [][2]float64 `json:"coordinates"`
			} `json:"geometry"`
			Properties struct {
				Class  string `json:"class"`
				OneWay bool   `json:"oneway"`
				Name   string `json:"name"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(data, &fc); err != nil {
		t.Fatal(err)
	}
	if len(fc.Features) != len(c.Ways) {
		t.Fatalf("%d features para %d vias", len(fc.Features), len(c.Ways))
	}
	for _, f := range fc.Features {
		if f.Properties.Name == "Rua C" {
			first := f.Geometry.Coordinates[0]
			if math.Abs(first[1]-at[3][0]) > 1e-6 || math.Abs(first[0]-at[3][1]) > 1e-6 {
				t.Fatalf("Rua C deveria começar no nó 3, começa em %v", first)
			}
			return
		}
	}
	t.Fatal("Rua C não apareceu no GeoJSON")
}

func TestLojaRealVaiParaOCruzamentoMaisProximo(t *testing.T) {
	roads, at := fixture()
	places, _ := json.Marshal(map[string]any{"elements": []map[string]any{
		{"type": "node", "id": 100, "lat": at[2][0] + 0.0003, "lon": at[2][1], "tags": map[string]string{"amenity": "restaurant", "name": "Acarajé da Esquina"}},
		{"type": "way", "id": 101, "center": map[string]float64{"lat": at[4][0], "lon": at[4][1] + 0.0002}, "tags": map[string]string{"amenity": "fast_food", "name": "Lanche"}},
		{"type": "node", "id": 102, "lat": at[2][0], "lon": at[2][1], "tags": map[string]string{"amenity": "restaurant"}},
		{"type": "node", "id": 103, "lat": at[2][0], "lon": at[2][1], "tags": map[string]string{"amenity": "bar", "name": "Bar"}},
		{"type": "node", "id": 104, "lat": at[2][0] + 0.01, "lon": at[2][1], "tags": map[string]string{"amenity": "cafe", "name": "Longe"}},
	}})
	c, report, err := FromOverpass("Teste", strings.NewReader(roads), strings.NewReader(string(places)))
	if err != nil {
		t.Fatal(err)
	}
	if report.Places != 2 {
		t.Fatalf("%d lojas, esperado 2", report.Places)
	}
	want := map[string]int32{"Acarajé da Esquina": nodeAt(t, c, at[2][0], at[2][1]), "Lanche": nodeAt(t, c, at[4][0], at[4][1])}
	for _, a := range c.Addresses {
		if a.Kind != Store {
			continue
		}
		if want[a.Name] != a.Node {
			t.Errorf("loja %q no nó %d, esperado %d", a.Name, a.Node, want[a.Name])
		}
	}
}

func TestProjecaoVaiEVolta(t *testing.T) {
	c := &City{OriginLat: -12.97, OriginLon: -38.48}
	for _, p := range [][2]float64{{-12.97, -38.48}, {-13.01, -38.53}, {-12.90, -38.32}} {
		x, y := c.ToXY(p[0], p[1])
		lat, lon := c.ToLatLon(x, y)
		if math.Abs(lat-p[0]) > 1e-12 || math.Abs(lon-p[1]) > 1e-12 {
			t.Fatalf("%v virou (%f, %f)", p, lat, lon)
		}
	}
	x, _ := c.ToXY(-12.97, -38.47)
	if math.Abs(x-1084.5) > 1 {
		t.Fatalf("0,01° de longitude em Salvador deu %.1f m", x)
	}
}

func TestSalvadorVersionada(t *testing.T) {
	c, err := Load(repoPath("cities", "salvador", "city.gob.gz"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Name != "Salvador" || !strings.Contains(c.Source, "OpenStreetMap") {
		t.Fatalf("cidade %q, fonte %q", c.Name, c.Source)
	}
	if len(c.Nodes) < 100_000 {
		t.Fatalf("só %d nós", len(c.Nodes))
	}
	if !c.StronglyConnected() {
		t.Fatal("Salvador versionada não é fortemente conexa")
	}
	b := c.Bounds()
	if b[0] < -38.7 || b[2] > -38.2 || b[1] < -13.1 || b[3] > -12.7 {
		t.Fatalf("limites fora de Salvador: %v", b)
	}
	for i, s := range c.Streets {
		if s.Meters <= 0 || s.SpeedKMH < 5 || s.SpeedKMH > 130 || int(s.Way) >= len(c.Ways) {
			t.Fatalf("trecho %d inválido: %+v", i, s)
		}
	}
	stores := 0
	for _, a := range c.Addresses {
		if int(a.Node) >= len(c.Nodes) {
			t.Fatalf("endereço fora da malha: %+v", a)
		}
		if a.Kind == Store {
			stores++
			if a.Name == "" {
				t.Fatalf("loja sem nome no nó %d", a.Node)
			}
		}
	}
	if stores < 1000 {
		t.Fatalf("só %d lojas", stores)
	}
}

func TestImportacaoEhReproduzivel(t *testing.T) {
	dir := repoPath("cities", "salvador")
	roads, err := os.Open(filepath.Join(dir, "osm-roads.json"))
	if err != nil {
		t.Skip("sem a cópia local do OpenStreetMap; rode go run ./cmd/osmimport")
	}
	defer roads.Close()
	places, err := os.Open(filepath.Join(dir, "osm-places.json"))
	if err != nil {
		t.Skip("sem a cópia local dos estabelecimentos")
	}
	defer places.Close()
	fresh, _, err := FromOverpass("Salvador", roads, places)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := Load(filepath.Join(dir, "city.gob.gz"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fresh, saved) {
		t.Fatalf("city.gob.gz difere da importação de %s: rode go run ./cmd/osmimport", dir)
	}
}
