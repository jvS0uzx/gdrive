package live

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
)

func setup(t *testing.T) (*miniredis.Miniredis, *redis.Client, *httptest.Server) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	hub := New(rdb, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	hub.Run(ctx)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/courier", hub.ServeCourier)
	mux.HandleFunc("GET /ws/watch/central", hub.ServeCentral)
	mux.HandleFunc("GET /ws/watch/order/{id}", hub.ServeOrder)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	time.Sleep(50 * time.Millisecond)
	return mr, rdb, ts
}

func dial(t *testing.T, ts *httptest.Server, path string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func send(t *testing.T, conn *websocket.Conn, p Point) {
	t.Helper()
	data, _ := json.Marshal(p)
	if err := conn.Write(context.Background(), websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("esperando: %s", what)
}

func readUntil(t *testing.T, conn *websocket.Conn, match func(map[string]any) bool) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("mensagem esperada não chegou: %v", err)
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) == nil && match(msg) {
			return msg
		}
	}
}

func TestPosicaoDoEntregadorVaiParaORedis(t *testing.T) {
	mr, rdb, ts := setup(t)
	conn := dial(t, ts, "/ws/courier?id=7")
	send(t, conn, Point{-12.97, -38.50})
	eventually(t, "hash do entregador", func() bool { return mr.Exists("courier:7") })
	got, err := rdb.GeoPos(context.Background(), GeoKey, "7").Result()
	if err != nil || len(got) != 1 || got[0] == nil {
		t.Fatalf("entregador fora do índice geográfico: %v %v", got, err)
	}
	if lat := mr.HGet("courier:7", "lat"); lat != "-12.97" {
		t.Fatalf("lat gravada %q", lat)
	}
}

func TestChegadaNaLojaDisparaUmaVezSo(t *testing.T) {
	mr, rdb, ts := setup(t)
	ctx := context.Background()
	rdb.HSet(ctx, TargetKey(9), "order_id", 42, "lat", -12.97, "lon", -38.50, "phase", "loja")
	conn := dial(t, ts, "/ws/courier?id=9")
	send(t, conn, Point{-12.975, -38.50})
	time.Sleep(100 * time.Millisecond)
	if n, _ := rdb.XLen(ctx, TrackingStream).Result(); n != 0 {
		t.Fatalf("chegada disparada a 550 m da loja: %d eventos", n)
	}
	for range 3 {
		send(t, conn, Point{-12.9702, -38.5001})
	}
	eventually(t, "evento de chegada", func() bool {
		n, _ := rdb.XLen(ctx, TrackingStream).Result()
		return n >= 1
	})
	time.Sleep(150 * time.Millisecond)
	msgs, _ := rdb.XRange(ctx, TrackingStream, "-", "+").Result()
	if len(msgs) != 1 || msgs[0].Values["type"] != "entregador_chegou_na_loja" {
		t.Fatalf("esperado um evento de chegada na loja, veio %v", msgs)
	}
	if !strings.Contains(msgs[0].Values["data"].(string), `"order_id":42`) {
		t.Fatalf("evento sem o pedido: %v", msgs[0].Values)
	}
	if mr.HGet(TargetKey(9), "arrived_loja") == "" {
		t.Fatal("marca de chegada não gravada no alvo")
	}
}

func TestCentralRecebeRetratoComEntregadoresEPedidos(t *testing.T) {
	_, rdb, ts := setup(t)
	central := dial(t, ts, "/ws/watch/central")
	courier := dial(t, ts, "/ws/courier?id=3")
	send(t, courier, Point{-12.98, -38.47})
	data, _ := json.Marshal(Event{Type: "pedido_criado", Order: 5, Version: 1, Status: "aguardando_loja", Store: &Point{-12.97, -38.50}, Customer: &Point{-12.99, -38.45}, Name: "Acarajé"})
	rdb.XAdd(context.Background(), &redis.XAddArgs{Stream: OrdersStream, Values: map[string]any{"type": "pedido_criado", "data": string(data)}})
	msg := readUntil(t, central, func(m map[string]any) bool {
		couriers, _ := m["couriers"].([]any)
		orders, _ := m["orders"].([]any)
		return m["type"] == "snapshot" && len(couriers) == 1 && len(orders) == 1
	})
	c := msg["couriers"].([]any)[0].([]any)
	if c[0].(float64) != 3 || c[1].(float64) != -38.47 || c[3].(float64) != 0 {
		t.Fatalf("entregador no retrato: %v", c)
	}
	o := msg["orders"].([]any)[0].(map[string]any)
	if o["status"] != "aguardando_loja" || o["store_name"] != "Acarajé" {
		t.Fatalf("pedido no retrato: %v", o)
	}
}

func TestQuemAcompanhaOPedidoRecebeEventoEPosicao(t *testing.T) {
	_, rdb, ts := setup(t)
	ctx := context.Background()
	watcher := dial(t, ts, "/ws/watch/order/11")
	time.Sleep(50 * time.Millisecond)
	data, _ := json.Marshal(Event{Type: "entregador_atribuido", Order: 11, Version: 3, Status: "a_caminho_da_loja", Courier: 4})
	rdb.XAdd(ctx, &redis.XAddArgs{Stream: OrdersStream, Values: map[string]any{"type": "entregador_atribuido", "data": string(data)}})
	ev := readUntil(t, watcher, func(m map[string]any) bool { return m["type"] == "evento" })
	if e := ev["event"].(map[string]any); e["status"] != "a_caminho_da_loja" || e["courier_id"].(float64) != 4 {
		t.Fatalf("evento repassado: %v", ev)
	}
	rdb.HSet(ctx, TargetKey(4), "order_id", 11, "lat", -12.90, "lon", -38.40, "phase", "loja")
	courier := dial(t, ts, "/ws/courier?id=4")
	send(t, courier, Point{-12.95, -38.45})
	pos := readUntil(t, watcher, func(m map[string]any) bool { return m["type"] == "posicao" })
	if pos["courier_id"].(float64) != 4 || pos["lat"].(float64) != -12.95 || pos["phase"] != "loja" {
		t.Fatalf("posição repassada: %v", pos)
	}
}

func TestEstadoReconstruidoDoHistoricoAoSubir(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	for _, e := range []Event{
		{Type: "pedido_criado", Order: 1, Version: 1, Status: "aguardando_loja", Store: &Point{-12.97, -38.5}, Customer: &Point{-12.99, -38.45}},
		{Type: "pedido_aceito_pela_loja", Order: 1, Version: 2, Status: "em_preparo"},
		{Type: "pedido_criado", Order: 2, Version: 1, Status: "aguardando_loja", Store: &Point{-12.97, -38.5}, Customer: &Point{-12.99, -38.45}},
		{Type: "pedido_cancelado", Order: 2, Version: 2, Status: "cancelado"},
	} {
		data, _ := json.Marshal(e)
		rdb.XAdd(ctx, &redis.XAddArgs{Stream: OrdersStream, Values: map[string]any{"type": e.Type, "data": string(data)}})
	}
	hub := New(rdb, slog.New(slog.NewTextHandler(io.Discard, nil)))
	run, cancel := context.WithCancel(ctx)
	defer cancel()
	hub.Run(run)
	eventually(t, "pedidos reconstruídos", func() bool {
		var snap struct {
			Orders []orderState `json:"orders"`
		}
		if json.Unmarshal(hub.snapshot(), &snap) != nil {
			return false
		}
		return len(snap.Orders) == 1 && snap.Orders[0].ID == 1 && snap.Orders[0].Status == "em_preparo"
	})
}

func TestEventoVelhoNaoSobrescreveONovo(t *testing.T) {
	hub := New(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hub.apply(Event{Order: 1, Version: 3, Status: "na_loja", Store: &Point{1, 1}})
	hub.apply(Event{Order: 1, Version: 2, Status: "a_caminho_da_loja"})
	if s := hub.orders[1].Status; s != "na_loja" {
		t.Fatalf("status %q, esperado na_loja", s)
	}
}

func TestDistanciaEmMetros(t *testing.T) {
	d := Distance(Point{-12.97, -38.50}, Point{-12.98, -38.50})
	if d < 1100 || d > 1125 {
		t.Fatalf("0,01° de latitude deu %.1f m", d)
	}
}

func TestEventoSemNomeDaLojaNaoApagaONome(t *testing.T) {
	hub := New(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hub.apply(Event{Type: "pedido_criado", Order: 1, Version: 1, Status: "aguardando_loja", Store: &Point{1, 1}, Name: "Acarajé"})
	hub.apply(Event{Type: "entregador_atribuido", Order: 1, Version: 3, Status: "a_caminho_da_loja", Store: &Point{1, 1}, Courier: 9})
	if o := hub.orders[1]; o.Name != "Acarajé" || o.Courier != 9 {
		t.Fatalf("pedido depois da atribuição: %+v", o)
	}
}
