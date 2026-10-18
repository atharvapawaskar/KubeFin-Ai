# Kubefin Worker

The Worker is the asynchronous control-plane service. It provides validated startup configuration, health/readiness routes, a separate Prometheus listener, graceful process shutdown, Redis Streams consumption, idempotent MongoDB persistence, per-event token cost calculation, and Stage 4 hourly/daily cost rollups. Stage 3 currency-aware pricing and Stage 4 aggregation contracts are merged; production prices must still be reviewed before loading.

## Current layout

```text
services/worker/
├── src/
│   ├── app.ts       # liveness and readiness routes
│   ├── config.ts    # startup environment validation
│   ├── main.ts      # dependency connections and process lifecycle
│   ├── metrics.ts   # separate Prometheus listener
│   ├── cost-engine.ts # exact token-cost calculation
│   ├── cost-aggregation.ts # bounded UTC rollups and generation-safe reads/writes
│   ├── cost-aggregation-cli.ts # strict rollup command argument validation
│   ├── pricing-catalog.ts # effective-dated MongoDB pricing lookup
│   ├── process-delivery.ts # validation/persist/DLQ/ack ordering
│   ├── redis-stream-port.ts # Redis Streams adapter
│   ├── stream-consumer.ts # group polling, recovery, and delivery policy
│   ├── usage-event.ts # v1 event validation and cost-enriched document mapping
│   └── usage-event-store.ts # MongoDB idempotent persistence and pricing enrichment
├── test/            # Node test-runner tests
├── scripts/aggregate-costs.mjs # dry-run-first hourly/daily rollup command
├── docs/
│   ├── ASSUMPTIONS.md
│   └── STATE.md
├── package.json
├── package-lock.json
├── tsconfig.json
└── .nvmrc
```

## Configuration

Required: `MONGODB_URI`, `REDIS_URL`.

Optional: `NODE_ENV` (defaults to `development`), `PORT` (defaults to `3000`), `METRICS_PORT` (defaults to `9090`), `PRICING_CURRENCY` (defaults to `INR`; uppercase ISO 4217 code), `REDIS_USAGE_STREAM` (`usage-events`), `REDIS_USAGE_GROUP` (`kubefin-worker-v1`), `WORKER_BATCH_SIZE` (`10`), `WORKER_BLOCK_MS` (`5000`), `WORKER_CLAIM_IDLE_MS` (`30000`), `WORKER_MAX_DELIVERIES` (`5`), and `WORKER_MAX_EVENT_BYTES` (`262144`). Bounds are validated at startup. `PORT` and `METRICS_PORT` must differ. The metrics listener serves only `GET /metrics`; the health listener serves `/healthz` and `/readyz`.

The Worker creates its Redis consumer group at stream ID `0`, reclaims idle pending entries with `XAUTOCLAIM`, validates each JSON payload against `contracts/events/usage-event.v1.json`, and stores accepted raw events in MongoDB with `eventId` as `_id`. Invalid payloads are represented in `usage-events:dlq` by a digest and size only; valid events that exhaust persistence retries retain their bounded event body for replay. The DLQ write and source acknowledgement are atomic. Stream trimming is intentionally disabled in the proposal so Redis cannot discard unprocessed events.

Before events receive a cost, the `pricing` collection must contain a single applicable rate for the event's exact provider/model, configured currency, and occurrence time. `PRICING_CURRENCY` selects a supported ISO 4217 code and defaults to `INR`. Curate the rate in that currency and retain its source URL and verification time; if the provider publishes only another currency, do not convert it without an approved FX source and policy. The Worker performs no foreign-exchange conversion. Rates use integer micro-units of currency per million tokens. Costs use integer arithmetic and are stored as MongoDB Decimal128 in `costAmount` with the corresponding `costCurrency`, preserving up to 12 decimal places. Aggregation must not add amounts from different currencies unless an approved FX policy is applied. When no matching rate exists, the Worker persists the event as `unpriced`, increments the `unpriced` outcome metric, and does not invent a cost. Overlapping active rates for the same provider/model/currency fail processing and leave the stream event pending for retry/DLQ handling.

The current usage-event v1 contract supplies only input/output counts. Provider-specific cached-token, cache-write, batch/service-tier, and long-context billing is outside this first calculator until the Gateway contract carries those dimensions; do not claim invoice-level accuracy for such traffic yet.

Import reviewed pricing records from a JSON array matching `contracts/db/pricing.v2.json` with `MONGODB_URI` set. Run `npm run pricing:import -- --file ./pricing.json` to validate and preview a dry run. Add `--apply` only to insert records. Existing records are immutable; the importer rejects changed IDs and overlapping intervals in the same currency, and never deletes rates. The Worker and importer create a partial v2 index; they never remove the legacy index automatically. Review the migration, then run `npm run pricing:migrate-index -- --apply` to add the currency/version-aware unique index and remove the old stricter index. This operation changes indexes only, not pricing documents. Backfill with `PRICING_CURRENCY` set to the target currency; old USD cost fields are removed only when a matching v2 rate is available.

After rates are loaded, `npm run pricing:backfill -- --batch-size 100` scans legacy Stage 2 events and previously unpriced events in bounded batches. It defaults to a dry run; add `--apply` to add cost metadata to eligible documents. It does not change usage fields or remove pricing records.

## Stage 4 cost aggregation

The Stage 4 contracts in `contracts/db/cost-aggregations.v1.json` and `contracts/db/cost-aggregation-windows.v1.json` define currency-separated hourly/daily snapshots and their publication state. Windows are UTC and end-exclusive. Events without pricing remain visible with a null currency and token/event counts, with no cost amount. The rollup refuses malformed source records rather than silently omitting them.

Run a dry run from an hour-aligned range (end exclusive):

```sh
npm run costs:aggregate -- --granularity hour --from 2026-10-17T05:00:00Z --to 2026-10-17T08:00:00Z
```

The command accepts at most 744 hourly windows or 366 daily windows per run. Add `--apply` to connect to MongoDB and publish the rollups. Rebuilds write a new generation and atomically switch each window's active generation only after aggregation succeeds. Readers must filter by the `activeGeneration` stored in `cost_aggregation_windows`; incomplete generations are not visible. The `MongoCostAggregationStore.queryActiveRange` read helper returns currency and pricing-status rows separately and never combines currencies. It is intended for the Control Plane integration; this change does not add an unauthenticated HTTP endpoint or alter the shared USD-only API contract.

No TTL policy is created. Decide and approve retention before removing raw events or aggregate snapshots. Validate the first applied runs against known source-event totals in a MongoDB environment before scheduling them in production.

## Stage 7 Kubernetes workload discovery

Discovery is opt-in and disabled unless `KUBERNETES_DISCOVERY_ENABLED=true`. When enabled, the Worker reads the in-cluster API using the projected ServiceAccount token and CA, builds an initial Pod snapshot with bounded pagination, then follows incremental Pod watch events. Kubernetes watch bookmarks advance the resume version; an expired version triggers a fresh snapshot. The request prefers Kubernetes partial object metadata with a JSON fallback; the Worker persists only Pod identity, owner references, and configured tenant/team/workload label values. Arbitrary labels, annotations, container specs, and environment variables are not persisted. Pod UID plus cluster ID and namespace form the stable inventory key. Pods missing configured identity labels remain visible in inventory without those identity fields. Deleted Pods are marked inactive.

Required when enabled: `KUBERNETES_CLUSTER_ID`, `KUBERNETES_TENANT_LABEL_KEY`, `KUBERNETES_TEAM_LABEL_KEY`, and `KUBERNETES_WORKLOAD_LABEL_KEY`. Label key names are deployment configuration because the team has not yet agreed on a cluster-wide label convention. Their values map to the existing usage-event `tenantId`, `teamId`, and `workloadId` fields; this implementation does not alter usage-event or raw-event contracts. `KUBERNETES_API_HOST` can explicitly set the API host; otherwise the standard in-cluster `KUBERNETES_SERVICE_HOST` is used. `KUBERNETES_API_PORT` defaults to 443, and ServiceAccount token/CA file paths default to Kubernetes' standard mount paths.

`deploy/k8s/worker-workload-discovery-role.yaml` grants only `list` and `watch` access to Pods. Bind this ClusterRole to the actual Worker ServiceAccount during deployment. Do not enable discovery until the identity label keys and cluster ID are reviewed, and do not treat discovered metadata as Gateway attribution until Member 1 confirms the same mapping. The initial full snapshot is bounded to 100,000 Pods and subsequent updates are incremental; large clusters may require namespace-scoped watches.

## Local development

From this directory, use `npm ci`, `npm test`, and `npm start`. Start MongoDB and Redis using the repository's root Docker Compose file. The Worker must not log event payloads, prompts, completions, credentials, or PII.

## Stage 8 model evaluation recommendations

The initial deterministic rule compares a workload's observed model with lower-cost models from the same provider and currency. It requires exactly 30 complete UTC daily windows with published Stage 4 generations, priced usage, an explicit workload identity, and one candidate pricing rate that covers every day with usage. It skips unpriced, unattributed, incomplete, ambiguous, and non-saving cases. Savings use exact integer/Decimal128 arithmetic and are stored in the proposed recommendations v2 shape with source generations and candidate pricing-record IDs.

These are evaluation suggestions, not claims of equivalent quality or latency and not automatic routing changes. Provider and cache rules are excluded because the current usage contracts do not provide enough evidence for them. The existing v1 recommendation contract is USD-only; the currency-safe v2 database and API contracts were reviewed and merged in PR #24.

Preview a 30-day UTC window without writing:

```sh
npm run recommendations:generate -- --from 2026-09-01T00:00:00Z --to 2026-10-01T00:00:00Z
```

The CLI refuses to run if any daily aggregation window lacks a published generation. It bounds a run to 100,000 rollup rows, 10,000 pricing records, and 10,000 output recommendations; larger runs fail closed and should be partitioned by tenant. Preview output shows at most 100 items. Add `--apply` to upsert recommendations by deterministic ID. The command does not schedule itself; scheduling and retention remain deployment decisions. The authenticated Control Plane exposes persisted records at `GET /api/v2/recommendations` with currency-separated ordering and signed pagination.

## Dependency choices

- Fastify supplies the HTTP health server and its Pino logger.
- Zod validates environment configuration at startup.
- `@prometheus-io/client` supplies Prometheus metrics; the upstream project identifies it as the successor to the deprecated `prom-client` package.
- The official MongoDB and Redis Node clients provide dependency connections and readiness pings.
- TypeScript and Node's built-in test runner provide strict compilation and tests without an extra test framework.


## Reliability checks and operations

The runbook for deployment, recovery, DLQ handling, rollback, security checks, and cost reconciliation is [docs/RUNBOOK.md](docs/RUNBOOK.md). Run the Worker reliability integration test against disposable or explicitly provisioned MongoDB and Redis services with:

```sh
WORKER_INTEGRATION_MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
WORKER_INTEGRATION_REDIS_URL='redis://127.0.0.1:6379' \
npm run test:integration
```

The test creates a uniquely named temporary database and Redis streams and removes them after completion. Use isolated test services; do not point it at production data.
