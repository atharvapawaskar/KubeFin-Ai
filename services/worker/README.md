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

## Local development

From this directory, use `npm ci`, `npm test`, and `npm start`. Start MongoDB and Redis using the repository's root Docker Compose file. The Worker must not log event payloads, prompts, completions, credentials, or PII.

## Dependency choices

- Fastify supplies the HTTP health server and its Pino logger.
- Zod validates environment configuration at startup.
- `@prometheus-io/client` supplies Prometheus metrics; the upstream project identifies it as the successor to the deprecated `prom-client` package.
- The official MongoDB and Redis Node clients provide dependency connections and readiness pings.
- TypeScript and Node's built-in test runner provide strict compilation and tests without an extra test framework.
