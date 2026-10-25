package live

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"
)

// Buckets de 0,1 ms a ~2,5 s em degraus de 1,5×. Com degraus de 2×, um p99 entre 51 e 102 ms
// caía todo no mesmo bucket, e é nessa faixa que fica o fan-out com a gravação em lote.
var fastBuckets = prometheus.ExponentialBuckets(0.0001, 1.5, 26)

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

	flushSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gdrive_position_flush_seconds",
		Help:    "Tempo para gravar e publicar um lote de posições no Redis.",
		Buckets: fastBuckets,
	})

	batchSize = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gdrive_position_batch_size",
		Help:    "Posições por lote gravado no Redis.",
		Buckets: prometheus.ExponentialBuckets(1, 2, 12),
	})

	flushErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "gdrive_position_flush_errors_total",
		Help: "Lotes de posições que o Redis recusou.",
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

// ObservePool expõe o pool de conexões do Redis. Quando a ida e volta ao Redis fica lenta, as
// posições passam a esperar conexão livre, e é aqui que a espera aparece.
func ObservePool(rdb *redis.Client) {
	stats := rdb.PoolStats
	promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "gdrive_redis_pool_conns",
		Help: "Conexões abertas no pool do Redis.",
	}, func() float64 { return float64(stats().TotalConns) })
	promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "gdrive_redis_pool_pending",
		Help: "Comandos esperando uma conexão livre do pool.",
	}, func() float64 { return float64(stats().PendingRequests) })
	promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "gdrive_redis_pool_waits_total",
		Help: "Vezes em que um comando esperou conexão livre.",
	}, func() float64 { return float64(stats().WaitCount) })
	promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "gdrive_redis_pool_wait_seconds_total",
		Help: "Tempo total esperando conexão livre.",
	}, func() float64 { return float64(stats().WaitDurationNs) / 1e9 })
	promauto.NewCounterFunc(prometheus.CounterOpts{
		Name: "gdrive_redis_pool_timeouts_total",
		Help: "Esperas por conexão que estouraram o prazo.",
	}, func() float64 { return float64(stats().Timeouts) })
}
