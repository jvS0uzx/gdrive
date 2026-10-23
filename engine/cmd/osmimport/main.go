package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jvS0uzx/gdrive/engine/internal/city"
)

const (
	overpassURL = "https://overpass-api.de/api/interpreter"
	userAgent   = "gdrive-osm-import/0.1 (+https://github.com/jvS0uzx/gdrive)"
)

const area = `area["name"="%s"]["admin_level"="4"]->.estado;
rel(area.estado)["name"="%s"]["admin_level"="8"]["boundary"="administrative"];
map_to_area->.a;
`

const roadsQuery = `[out:json][timeout:300];
` + area + `way(area.a)["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"];
out body;
>;
out skel qt;
`

const placesQuery = `[out:json][timeout:180];
` + area + `nwr(area.a)["amenity"~"^(restaurant|fast_food|cafe|ice_cream|bar|pub)$"];
out center tags;
`

func fetch(query, path string) error {
	req, err := http.NewRequest(http.MethodPost, overpassURL, strings.NewReader(url.Values{"data": {query}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	client := http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("overpass respondeu %d: %s", resp.StatusCode, body)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

func ensure(query, path string, refresh bool) error {
	if _, err := os.Stat(path); err == nil && !refresh {
		return nil
	}
	fmt.Printf("baixando %s da Overpass\n", filepath.Base(path))
	return fetch(query, path)
}

func main() {
	name := flag.String("name", "Salvador", "município no OpenStreetMap")
	state := flag.String("state", "Bahia", "estado do município")
	dir := flag.String("dir", "../cities/salvador", "pasta da cidade")
	refresh := flag.Bool("refresh", false, "baixa de novo mesmo com cópia local")
	flag.Parse()

	roadsPath := filepath.Join(*dir, "osm-roads.json")
	placesPath := filepath.Join(*dir, "osm-places.json")
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatal(err)
	}
	if err := ensure(fmt.Sprintf(roadsQuery, *state, *name), roadsPath, *refresh); err != nil {
		log.Fatal(err)
	}
	if err := ensure(fmt.Sprintf(placesQuery, *state, *name), placesPath, *refresh); err != nil {
		log.Fatal(err)
	}

	roads, err := os.Open(roadsPath)
	if err != nil {
		log.Fatal(err)
	}
	defer roads.Close()
	places, err := os.Open(placesPath)
	if err != nil {
		log.Fatal(err)
	}
	defer places.Close()

	began := time.Now()
	c, report, err := city.FromOverpass(*name, roads, places)
	if err != nil {
		log.Fatal(err)
	}

	byClass := map[city.Class]int{}
	var meters float64
	oneWay := 0
	for _, s := range c.Streets {
		byClass[s.Class]++
		meters += s.Meters
		if s.OneWay {
			oneWay++
		}
	}
	byKind := map[city.AddressKind]int{}
	for _, a := range c.Addresses {
		byKind[a.Kind]++
	}
	degree := make([]int, len(c.Nodes))
	for _, s := range c.Streets {
		degree[s.From]++
		degree[s.To]++
	}
	junctions := 0
	for _, d := range degree {
		if d >= 3 {
			junctions++
		}
	}
	b := c.Bounds()
	x0, y0 := c.ToXY(b[1], b[0])
	x1, y1 := c.ToXY(b[3], b[2])

	fmt.Printf("%s, %s, importada em %s\n", c.Name, c.Source, time.Since(began).Round(time.Millisecond))
	fmt.Printf("vias: %d (%d ignoradas por acesso ou geometria), %d de mão única, %d rotatórias, %d com velocidade no mapa\n",
		report.Ways, report.SkippedWays, report.OneWayWays, report.Roundabouts, report.TaggedSpeed)
	fmt.Printf("nós: %d (%d cruzamentos), %d descartados fora do maior componente fortemente conexo\n",
		len(c.Nodes), junctions, report.DroppedNodes)
	fmt.Printf("trechos: %d, %.0f km de via, %d de mão única\n", len(c.Streets), meters/1000, oneWay)
	for _, cl := range city.Classes {
		fmt.Printf("  %-9s %6d\n", cl, byClass[cl])
	}
	fmt.Printf("endereços: %d lojas reais, %d casas de entregador, %d casas de cliente\n",
		byKind[city.Store], byKind[city.CourierHome], byKind[city.Customer])
	fmt.Printf("extensão: %.1f × %.1f km\n", (x1-x0)/1000, (y1-y0)/1000)
	fmt.Printf("fortemente conexa: %v\n", c.StronglyConnected())

	out := filepath.Join(*dir, "city.gob.gz")
	if err := c.Save(out); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("gravada em %s\n", out)
}
