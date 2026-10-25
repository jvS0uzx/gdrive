package live

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Buckets de 0,1 ms a ~1,6 s: o caminho quente vive abaixo de 10 ms, e a cauda é o que a fase 3 mede.
var fastBuckets = prometheus.ExponentialBuckets(0.0001, 2, 15)

var (
	wsConnections = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "gdrive_ws_connections",
		Help: "WebSockets abertos nesta instância, por tipo.",
	}, []string{"kind"})

	positionsReceived = promauto.NewCounter(prometheus.CounterOpts{
		Name: "gdrive_positions_received_total",
		Help: "Posições aceitas do WebSocket do entregador.",
	})

	positionUpdate = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gdrive_position_update_seconds",
		Help:    "Tempo para processar uma posição, incluindo o pipeline no Redis.",
		Buckets: fastBuckets,
	})

	positionFanout = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gdrive_position_fanout_seconds",
		Help:    "Da posição recebida por uma instância até chegar a esta pelo pub/sub.",
		Buckets: fastBuckets,
	})

	snapshotBuild = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gdrive_snapshot_build_seconds",
		Help:    "Tempo para montar o retrato da central.",
		Buckets: fastBuckets,
	})

	snapshotBytes = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "gdrive_snapshot_bytes",
		Help: "Tamanho do último retrato da central.",
	})

	snapshotCouriers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "gdrive_snapshot_couriers",
		Help: "Entregadores no último retrato da central.",
	})

	wsDropped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "gdrive_ws_dropped_total",
		Help: "Mensagens descartadas porque o cliente não acompanhou.",
	}, []string{"kind"})
)

// Séries zeradas desde a subida: sem isso o painel mostra "sem dados" até o primeiro evento.
func init() {
	for _, kind := range []string{"courier", "central", "order"} {
		wsConnections.WithLabelValues(kind)
	}
	for _, kind := range []string{"central", "order"} {
		wsDropped.WithLabelValues(kind)
	}
}
