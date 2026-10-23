package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
	"github.com/jvS0uzx/gdrive/engine/internal/route"
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
	s, err := New(c, route.New(c), slog.New(slog.NewTextHandler(io.Discard, nil)))
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
