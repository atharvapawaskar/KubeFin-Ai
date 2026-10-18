# Prometheus monitoring for the Worker

The Worker exposes application health on port `3000` and Prometheus metrics on port `9090`. The Helm chart creates a ClusterIP Service for both ports and adds Prometheus scrape annotations to that Service by default. Keep the metrics service internal to the cluster and restrict access with the cluster's network policy.

## Prometheus Operator-free setup

Merge the `scrape_configs` entry in [worker-scrape.yml](worker-scrape.yml) into the Prometheus server configuration. The Prometheus service account needs permission to discover Kubernetes endpoints. Reload Prometheus after updating its configuration.

For Prometheus Operator installations, configure a `ServiceMonitor` to select the chart's Worker Service and scrape the named `metrics` port at `/metrics`; the chart does not install CRDs or assume an Operator is present.

Load [worker-alerts.yml](worker-alerts.yml) as a Prometheus rule file. Thresholds are starting points and should be tuned from measured throughput, event size, and service objectives. `worker_usage_stream_lag_messages` reports Redis stream entries not yet delivered to the consumer group; it does not count entries pending acknowledgement.

Worker metrics use bounded labels (`outcome` only). Do not add event IDs, tenant IDs, workload names, model names, or other per-event values as labels. The current metrics are:

- `worker_usage_events_total{outcome}` — event outcomes including inserted, duplicate, unpriced, dead-lettered, and retrying.
- `worker_usage_event_processing_duration_seconds` — processing duration histogram.
- `worker_usage_stream_lag_messages` — most recently sampled consumer-group stream lag.

The lag gauge is updated on a best-effort interval. Redis versions that do not return group lag leave it unchanged; Redis query errors do not stop event processing.
