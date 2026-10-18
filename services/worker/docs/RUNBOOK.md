# Worker operations runbook

This runbook covers the Stage 9 Helm deployment and Stage 10 reliability checks. Run the procedures in a non-production namespace first. Production image tags, alert thresholds, load objectives, label keys, and secret values must come from the owning team and deployment environment; this repository does not define those environment-specific values.

## Pre-deploy checks

1. Use an immutable image from the team's approved registry. Do not deploy the chart's `kubefin-worker:local` default to a shared cluster.
2. Provision a namespace and the `kubefin-worker-runtime` Secret through the approved secret manager or cluster secret workflow. It must contain `MONGODB_URI` and `REDIS_URL`; never paste secret values into shell history, tickets, logs, or this runbook.
3. Verify the MongoDB account is limited to the Worker collections and required indexes, and the Redis account is limited to the configured usage and dead-letter streams plus the commands those adapters need.
4. Keep `kubernetesDiscovery.enabled=false` until the team approves the cluster-wide label mapping and Pod metadata access. The optional ClusterRole can list/watch Pods across namespaces.
5. Set resource requests and limits from load measurements. The chart defaults are starting points, not service-level objectives.

## Deploy and smoke-check

Install or update the Worker using the chart's [deployment guide](../../deploy/helm/worker/README.md), an immutable image tag, and the prepared Secret. Then verify rollout and pod state:

```sh
kubectl -n kubefin rollout status deployment/kubefin-kubefin-worker
kubectl -n kubefin get deployment,pods,service kubefin-kubefin-worker
```

For a local inspection tunnel, forward the internal Service ports and query health and metrics:

```sh
kubectl -n kubefin port-forward service/kubefin-kubefin-worker 3000:3000 9090:9090
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
curl --fail http://127.0.0.1:9090/metrics
```

`/healthz` checks that the process is live. `/readyz` must return success only when MongoDB and Redis respond. The metrics listener is separate from the application listener and the Service is ClusterIP; restrict metrics access with the platform's network policy and scrape configuration.

## Triage queue lag or delivery failures

1. Check `worker_usage_stream_lag_messages`, `worker_usage_events_total{outcome=...}`, the Worker target's Prometheus `up` value, and the `kubefin-worker` alert rules. Treat the configured thresholds as starting points until an SLO is approved.
2. Inspect recent Worker logs for connection, retry, or acknowledgement messages. Logs should contain stream entry IDs and error categories, never event payloads, prompts, credentials, or tenant labels.
3. If MongoDB is unavailable, restore the dependency first. The Worker leaves unpersisted entries pending and retries them; do not acknowledge or delete the entries manually. Verify lag decreases and event IDs appear once after recovery.
4. If Redis is unavailable, restore the dependency and let the Worker reconnect. Do not trim or delete the source stream or DLQ during recovery.
5. Inspect DLQ metadata only with an approved Redis operator account. Invalid payloads are represented by byte count and digest; exhausted persistence events may include a bounded schema-valid payload under the reviewed Stage 2 contract. Treat that body as sensitive, restrict access, and do not copy it into logs or tickets.
6. No automated DLQ replay command is defined. Do not bulk replay or manually rewrite DLQ records. Reprocessing requires a reviewed incident procedure that preserves event identity and prevents duplicate cost records.

## Restart and rollback

Use a controlled restart only after dependency health has been checked:

```sh
kubectl -n kubefin rollout restart deployment/kubefin-kubefin-worker
kubectl -n kubefin rollout status deployment/kubefin-kubefin-worker
```

For a Helm-managed deployment, inspect release history and roll back to a reviewed revision:

```sh
helm history kubefin -n kubefin
helm rollback kubefin REVISION -n kubefin
kubectl -n kubefin rollout status deployment/kubefin-kubefin-worker
```

Rollback only restores the prior chart/image. It does not reverse MongoDB data or index changes; review database changes separately before any stateful rollback.

## Security verification

- Confirm the deployed container is non-root, has a read-only root filesystem, drops all Linux capabilities, and uses the default seccomp profile.
- Confirm the ServiceAccount token is not mounted when workload discovery is disabled. If discovery is enabled, verify the ServiceAccount has only `list`/`watch` on Pods and that no write verbs are granted.
- Verify credentials come only from the pre-created Secret. Do not use `kubectl get secret -o yaml` in shared terminals or recorded sessions.
- Confirm metrics are reachable only from approved in-cluster scrapers and the Service is not exposed through a public Ingress or LoadBalancer.
- Review logs and DLQ metadata handling before sharing incident artifacts. Avoid event IDs and tenant/workload identifiers as metric labels.

## Cost reconciliation and release evidence

For an agreed sample window, compare the same event IDs and UTC boundaries across source events and Worker documents. Sum input/output tokens separately, calculate the expected cost from the exact effective pricing record used for each event, compare Decimal128 values without floating-point conversion, and report currencies separately. Include the priced, unpriced, duplicate, and dead-letter counts; do not treat missing prices as zero or silently convert currencies. The Stage 10 Redis/MongoDB integration test verifies one deterministic INR case, but it does not replace reconciliation against reviewed provider rates or invoices.

Before approving a production release, record measured throughput, CPU/memory, p95 processing duration, stream lag, and recovery time. Agree on load targets and alert thresholds with the team; no numerical production SLO is assumed here.
