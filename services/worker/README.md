# Kubefin Worker

The Worker is the asynchronous control-plane service. Its first slice provides validated startup configuration, health/readiness routes, a separate Prometheus listener, and graceful process shutdown. Event consumption and persistence will be added only against the approved contracts.

## Current layout

```text
services/worker/
├── src/
│   ├── app.ts       # liveness and readiness routes
│   ├── config.ts    # startup environment validation
│   ├── main.ts      # dependency connections and process lifecycle
│   └── metrics.ts   # separate Prometheus listener
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

Optional: `NODE_ENV` (defaults to `development`), `PORT` (defaults to `3000`), and `METRICS_PORT` (defaults to `9090`). `PORT` and `METRICS_PORT` must differ. The metrics listener serves only `GET /metrics`; the health listener serves `/healthz` and `/readyz`.

## Local development

From this directory, use `npm ci`, `npm test`, and `npm start`. Start MongoDB and Redis using the repository's root Docker Compose file. The Worker must not log event payloads, prompts, completions, credentials, or PII.

## Dependency choices

- Fastify supplies the HTTP health server and its Pino logger.
- Zod validates environment configuration at startup.
- `@prometheus-io/client` supplies Prometheus metrics; the upstream project identifies it as the successor to the deprecated `prom-client` package.
- The official MongoDB and Redis Node clients provide dependency connections and readiness pings.
- TypeScript and Node's built-in test runner provide strict compilation and tests without an extra test framework.
