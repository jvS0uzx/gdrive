package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
	"github.com/jvS0uzx/gdrive/engine/internal/live"
	"github.com/jvS0uzx/gdrive/engine/internal/route"
	"github.com/jvS0uzx/gdrive/engine/internal/tiles"
)

func gridCity(t *testing.T) *city.City {
	t.Helper()
	var elements []map[string]any
	id := func(i, j int) int64 { return int64(i*10 + j + 1) }
	for i := range 6 {
		for j := range 6 {
			elements = append(elements, map[string]any{"type": "node", "id": id(i, j), "lat": -12.97 + float64(i)*0.002, "lon": -38.50 + float64(j)*0.002})
		}
	}
	wayID := int64(1000)
	for i := range 6 {
		row, col := []int64{}, []int64{}
		for j := range 6 {
			row = append(row, id(i, j))
			col = append(col, id(j, i))
		}
		elements = append(elements,
			map[string]any{"type": "way", "id": wayID, "nodes": row, "tags": map[string]string{"highway": "residential", "name": fmt.Sprintf("Rua %d", i)}},
			map[string]any{"type": "way", "id": wayID + 1, "nodes": col, "tags": map[string]string{"highway": "primary", "name": fmt.Sprintf("Avenida %d", i)}},
		)
		wayID += 2
	}
	data, _ := json.Marshal(map[string]any{"osm3s": map[string]string{"timestamp_osm_base": "2026-10-23T00:00:00Z"}, "elements": elements})
	c, _, err := city.FromOverpass("Grade", bytes.NewReader(data), nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func newTestServer(t *testing.T) (*httptest.Server, *city.City) {
	t.Helper()
	c := gridCity(t)
	s, err := New(c, route.New(c), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, c
}

func post(t *testing.T, url, body string) (*http.Response, map[string]any) {
	t.Helper()
	resp, err := http.Post(url+"/route", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return resp, out
}

func pointOf(c *city.City, n int32) map[string]float64 {
	lat, lon := c.LatLon(n)
	return map[string]float64{"lat": lat, "lon": lon}
}

func TestRotaEntreDoisCruzamentos(t *testing.T) {
	ts, c := newTestServer(t)
	last := int32(len(c.Nodes) - 1)
	body, _ := json.Marshal(map[string]any{"from": pointOf(c, 0), "to": pointOf(c, last)})
	resp, out := post(t, ts.URL, string(body))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %v", resp.StatusCode, out)
	}
	if out["from_node"].(float64) != 0 || int32(out["to_node"].(float64)) != last {
		t.Fatalf("snap errado: %v → %v", out["from_node"], out["to_node"])
	}
	roads := out["roads"].([]any)
	if len(roads) == 0 {
		t.Fatal("rota sem nenhuma via nomeada")
	}
	seen := map[string]bool{}
	for _, r := range roads {
		name := r.(map[string]any)["name"].(string)
		if !strings.HasPrefix(name, "Avenida") && !strings.HasPrefix(name, "Rua") {
			t.Fatalf("via inesperada na rota: %q", name)
		}
		if seen[name] {
			t.Fatalf("via %q repetida na lista", name)
		}
		seen[name] = true
	}
	coords := out["path"].(map[string]any)["coordinates"].([]any)
	cumulative := out["cumulative_seconds"].([]any)
	if len(coords) < 2 || len(coords) != len(cumulative) {
		t.Fatalf("%d pontos e %d tempos", len(coords), len(cumulative))
	}
	if cumulative[len(cumulative)-1].(float64) != out["seconds"].(float64) {
		t.Fatalf("último acumulado %v diferente do total %v", cumulative[len(cumulative)-1], out["seconds"])
	}
}

func TestChuvaDeixaARotaMaisLenta(t *testing.T) {
	ts, c := newTestServer(t)
	last := int32(len(c.Nodes) - 1)
	dry, _ := json.Marshal(map[string]any{"from": pointOf(c, 0), "to": pointOf(c, last)})
	wet, _ := json.Marshal(map[string]any{"from": pointOf(c, 0), "to": pointOf(c, last), "rain": true})
	_, a := post(t, ts.URL, string(dry))
	_, b := post(t, ts.URL, string(wet))
	if b["seconds"].(float64) <= a["seconds"].(float64) {
		t.Fatalf("chuva %v s, seco %v s", b["seconds"], a["seconds"])
	}
}

func TestErrosDeEntrada(t *testing.T) {
	ts, _ := newTestServer(t)
	cases := []struct {
		name, body string
		status     int
	}{
		{"json quebrado", `{"from":`, http.StatusBadRequest},
		{"sem destino", `{"from":{"lat":-12.97,"lon":-38.5}}`, http.StatusBadRequest},
		{"latitude impossível", `{"from":{"lat":95,"lon":0},"to":{"lat":-12.97,"lon":-38.5}}`, http.StatusBadRequest},
		{"fora da cidade", `{"from":{"lat":-12.9,"lon":-38.4},"to":{"lat":-12.97,"lon":-38.5}}`, http.StatusUnprocessableEntity},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, out := post(t, ts.URL, tc.body)
			if resp.StatusCode != tc.status || out["error"] == "" {
				t.Fatalf("status %d, esperado %d: %v", resp.StatusCode, tc.status, out)
			}
		})
	}
}

func TestCidadeServeMetaEGeoJSON(t *testing.T) {
	ts, c := newTestServer(t)
	resp, err := http.Get(ts.URL + "/city")
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	err = json.NewDecoder(resp.Body).Decode(&meta)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if int(meta["nodes"].(float64)) != len(c.Nodes) || meta["name"] != "Grade" || meta["junctions"].(float64) != 32 {
		t.Fatalf("meta inesperada: %v", meta)
	}
	if !strings.Contains(meta["source"].(string), "OpenStreetMap") {
		t.Fatalf("meta sem crédito do OpenStreetMap: %v", meta["source"])
	}
	resp, err = http.Get(ts.URL + "/city.geojson")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/geo+json" {
		t.Fatalf("content-type %q", ct)
	}
	var fc struct {
		Features []any `json:"features"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&fc); err != nil {
		t.Fatal(err)
	}
	if len(fc.Features) != len(c.Ways) {
		t.Fatalf("%d features para %d vias", len(fc.Features), len(c.Ways))
	}
}

func TestETADeVariosEntregadoresAteUmPonto(t *testing.T) {
	c := gridCity(t)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	hub := live.New(rdb, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s, err := New(c, route.New(c), hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	ctx := context.Background()
	near, far := c.Point(1), c.Point(int32(len(c.Nodes)-1))
	rdb.HSet(ctx, live.CourierKey(1), "lat", near[1], "lon", near[0])
	rdb.HSet(ctx, live.CourierKey(2), "lat", far[1], "lon", far[0])
	target := pointOf(c, 0)
	body, _ := json.Marshal(map[string]any{"to": target, "couriers": []int64{1, 2, 3}})
	resp, err := http.Post(ts.URL+"/eta", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		ETAs []struct {
			Courier int64   `json:"courier_id"`
			Seconds float64 `json:"seconds"`
		} `json:"etas"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || len(out.ETAs) != 2 {
		t.Fatalf("status %d, etas %+v", resp.StatusCode, out.ETAs)
	}
	got := map[int64]float64{}
	for _, e := range out.ETAs {
		got[e.Courier] = e.Seconds
	}
	if !(got[1] > 0 && got[2] > got[1]) {
		t.Fatalf("o mais perto deveria chegar antes: %v", got)
	}
}

func TestEnderecosParaCargaInicial(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/city/addresses")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string][]map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"stores", "courier_homes", "customers"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("sem a lista %q: %v", k, out)
		}
	}
	if len(out["customers"]) == 0 || out["customers"][0]["lat"] == nil {
		t.Fatalf("clientes sem coordenada: %v", out["customers"])
	}
}

func TestSemRedisNaoHaTempoReal(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Post(ts.URL+"/eta", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("sem redis, /eta respondeu %d", resp.StatusCode)
	}
}

func TestAlternativasDeRota(t *testing.T) {
	ts, c := newTestServer(t)
	body, _ := json.Marshal(map[string]any{"from": pointOf(c, 0), "to": pointOf(c, int32(len(c.Nodes)-1))})
	resp, err := http.Post(ts.URL+"/route/alternatives", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]*struct {
		Seconds float64 `json:"seconds"`
		Meters  float64 `json:"meters"`
		Path    struct {
			Coordinates [][2]float64 `json:"coordinates"`
		} `json:"path"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	fast, short := out["fastest"], out["shortest"]
	if fast == nil || short == nil || len(fast.Path.Coordinates) < 2 {
		t.Fatalf("alternativas incompletas: %+v", out)
	}
	if fast.Seconds > short.Seconds || short.Meters > fast.Meters {
		t.Fatalf("rápida %+v, curta %+v", fast, short)
	}
	if _, ok := out["no_expressway"]; !ok {
		t.Fatal("faltou a chave no_expressway")
	}
}

func TestBlocosVetoriaisDaMalha(t *testing.T) {
	ts, c := newTestServer(t)
	resp, err := http.Get(ts.URL + "/city")
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Tiles struct {
			URL     string `json:"url"`
			MinZoom int    `json:"minzoom"`
			MaxZoom int    `json:"maxzoom"`
		} `json:"tiles"`
	}
	err = json.NewDecoder(resp.Body).Decode(&meta)
	resp.Body.Close()
	if err != nil || !strings.HasPrefix(meta.Tiles.URL, "/tiles/{z}/{x}/{y}.pbf?v=") || meta.Tiles.MinZoom != 9 || meta.Tiles.MaxZoom != 14 {
		t.Fatalf("meta dos blocos: %+v (%v)", meta.Tiles, err)
	}
	b := c.Bounds()
	k := tiles.TileOf((b[0]+b[2])/2, (b[1]+b[3])/2, 14)
	url := strings.NewReplacer("{z}", "14", "{x}", strconv.Itoa(k.X), "{y}", strconv.Itoa(k.Y)).Replace(meta.Tiles.URL)
	resp, err = http.Get(ts.URL + url)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/vnd.mapbox-vector-tile" || len(body) == 0 {
		t.Fatalf("bloco do centro: %d %q %d bytes", resp.StatusCode, resp.Header.Get("Content-Type"), len(body))
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("bloco versionado sem cache longo: %q", cc)
	}
	for path, want := range map[string]int{
		"/tiles/15/0/0.pbf":                            http.StatusNotFound,
		"/tiles/14/x/1.pbf":                            http.StatusBadRequest,
		"/tiles/14/" + strconv.Itoa(k.X+40) + "/1.pbf": http.StatusOK,
	} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s: %d, esperado %d", path, resp.StatusCode, want)
		}
	}
}
