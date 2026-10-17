# Kubefin Worker

The Worker is the asynchronous control-plane service. It provides validated startup configuration, health/readiness routes, a separate Prometheus listener, graceful process shutdown, and a Stage 2 Redis Streams consumer. The event, database, and Redis contract files in the current working tree are proposals awaiting project review; they must be approved before Gateway integration.

## Current layout

```text
services/worker/
├── src/
│   ├── app.ts       # liveness and readiness routes
│   ├── config.ts    # startup environment validation
│   ├── main.ts      # dependency connections and process lifecycle
│   ├── metrics.ts   # separate Prometheus listener
│   ├── process-delivery.ts # validation/persist/DLQ/ack ordering
│   ├── redis-stream-port.ts # Redis Streams adapter
│   ├── stream-consumer.ts # group polling, recovery, and delivery policy
│   ├── usage-event.ts # v1 event validation and raw document mapping
│   └── usage-event-store.ts # MongoDB idempotent persistence
├── test/            # Node test-runner tests
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

Optional: `NODE_ENV` (defaults to `development`), `PORT` (defaults to `3000`), `METRICS_PORT` (defaults to `9090`), `REDIS_USAGE_STREAM` (`usage-events`), `REDIS_USAGE_GROUP` (`kubefin-worker-v1`), `WORKER_BATCH_SIZE` (`10`), `WORKER_BLOCK_MS` (`5000`), `WORKER_CLAIM_IDLE_MS` (`30000`), `WORKER_MAX_DELIVERIES` (`5`), and `WORKER_MAX_EVENT_BYTES` (`262144`). Bounds are validated at startup. `PORT` and `METRICS_PORT` must differ. The metrics listener serves only `GET /metrics`; the health listener serves `/healthz` and `/readyz`.

The Worker creates its Redis consumer group at stream ID `0`, reclaims idle pending entries with `XAUTOCLAIM`, validates each JSON payload against `contracts/events/usage-event.v1.json`, and stores accepted raw events in MongoDB with `eventId` as `_id`. Invalid payloads are represented in `usage-events:dlq` by a digest and size only; valid events that exhaust persistence retries retain their bounded event body for replay. The DLQ write and source acknowledgement are atomic. Stream trimming is intentionally disabled in the proposal so Redis cannot discard unprocessed events.

## Local development

From this directory, use `npm ci`, `npm test`, and `npm start`. Start MongoDB and Redis using the repository's root Docker Compose file. The Worker must not log event payloads, prompts, completions, credentials, or PII.

## Dependency choices

- Fastify supplies the HTTP health server and its Pino logger.
- Zod validates environment configuration at startup.
- `@prometheus-io/client` supplies Prometheus metrics; the upstream project identifies it as the successor to the deprecated `prom-client` package.
- The official MongoDB and Redis Node clients provide dependency connections and readiness pings.
- TypeScript and Node's built-in test runner provide strict compilation and tests without an extra test framework.
