package server

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Só a busca no grafo: é o p99 dela que decide se Contraction Hierarchies vale o custo.
var routeSeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "gdrive_route_seconds",
	Help:    "Tempo da busca no grafo, por tipo de consulta.",
	Buckets: prometheus.ExponentialBuckets(0.0001, 1.5, 26),
}, []string{"kind"})

func init() {
	for _, kind := range []string{"route", "alternatives", "eta", "plan"} {
		routeSeconds.WithLabelValues(kind)
	}
}

func observeRoute(kind string, began time.Time) {
	routeSeconds.WithLabelValues(kind).Observe(time.Since(began).Seconds())
}
