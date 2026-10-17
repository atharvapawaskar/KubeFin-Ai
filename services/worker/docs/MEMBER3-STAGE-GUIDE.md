# Member 3 (Atharva) — Stage-by-Stage Guide

This guide scopes the KubeFin AI roadmap to Member 3's Worker and DevOps responsibilities. It distinguishes checked-in configuration from future architecture plans. Shared contracts are owned by all members and must be agreed before implementing cross-service behavior.

## 1. Project context

KubeFin AI is a Kubernetes-native AI FinOps platform. The Gateway handles AI requests synchronously. The Worker and control plane handle usage events asynchronously, calculate and aggregate cost, and provide spend data and controls to the dashboard.

Member 3 owns:

- `services/worker/`: event consumption and processing, cost calculation, aggregation, and recommendations.
- `deploy/`: Docker, Kubernetes, Helm, infrastructure, and observability assets.
- Control Plane API and budget API work are shared integrations in the project phase plan; coordinate their contracts and data access with Member 2.
- The Phase 0 plan also assigns CI/infra leadership to Member 3.

The Gateway implementation and usage-event production are Member 1 responsibilities. The dashboard UI is Member 2's responsibility. Work that crosses those boundaries depends on approved contracts and integration with those members.

## 2. Current repository configuration and actual state

### Docker Compose

The root `docker-compose.yml` currently defines only two local dependencies:

- **MongoDB 7** exposes host port `27017`, persists data in the named volume `mongodb_data`, checks readiness with a `mongosh` ping, and restarts unless stopped.
- **Redis 7 Alpine** exposes host port `6379`, enables append-only persistence, stores data in named volume `redis_data`, checks readiness with `redis-cli ping`, and restarts unless stopped.

Compose does **not** currently build or run the Worker, Gateway, API, frontend, Prometheus, or Grafana. `deploy/docker/` contains only `.gitkeep`; there is no Worker Dockerfile yet.

### Worker runtime

- Node is pinned by `services/worker/.nvmrc` to `24.22.0`; the package engine allows Node `>=24 <25`.
- Worker dependencies are Fastify, Zod, MongoDB, Redis, TypeScript, and `@prometheus-io/client`, pinned in `package.json`/lockfile.
- Required environment: `MONGODB_URI`, `REDIS_URL`.
- Optional environment: `NODE_ENV` (defaults to `development`), `PORT` (defaults to `3000`), `METRICS_PORT` (defaults to `9090`). The Worker rejects equal app and metrics ports.
- The Worker binds both listeners to `0.0.0.0`; this is recorded as assumption A-001 in `ASSUMPTIONS.md` and remains pending confirmation.
- `GET /healthz` is liveness. `GET /readyz` pings MongoDB and Redis and returns 503 if they are unavailable.
- A separate metrics listener serves only `GET /metrics` and currently collects default process/runtime metrics. Worker-specific event counters, lag, and processing-duration metrics have not been added.
- Redis reconnect handling and graceful SIGTERM/SIGINT shutdown are implemented. Event consumers and persistence are not yet implemented.

The root `.env.example` has MongoDB/Redis URLs, a generic `PORT=3000`, `NODE_ENV`, optional provider-key placeholders, and feature flags. It does not list `METRICS_PORT`; add Worker-specific variables there when the team agrees on how shared local configuration should be maintained. Do not put secrets in the repository.

### Kubernetes, Helm, Prometheus, and other observability

- `deploy/k8s/`, `deploy/helm/`, and `deploy/docker/` currently contain only `.gitkeep` placeholders.
- There are no Kubernetes Deployments, Services, probes, ConfigMaps/Secrets templates, Helm values, HPA, or ingress resources in the repository.
- There is no Prometheus configuration, ServiceMonitor, scrape annotation, Grafana dashboard, alert rule, Loki setup, or OpenTelemetry tracing setup.
- The architecture document describes these as planned production capabilities, not as already deployed configuration.
- The Worker exposes a metrics endpoint that a future Prometheus configuration can scrape; exposing `/metrics` alone does not configure Prometheus discovery or a dashboard.

### CI, contracts, and collaboration

- `.github/workflows/ci.yml` currently checks required files/directories and a few repository rules. Contract validation is a placeholder; service validation only reports whether package files exist. It does not yet run the Worker build or test suite.
- `.github/CODEOWNERS` assigns Worker and deploy paths to Member 3. Shared contracts and architecture documentation involve all three members.
- Contract workflow in `contracts/README.md` requires a contract-only PR and approvals from the other members before implementation depends on it.
- Current contract files include the Control Plane API and database schemas for budgets and recommendations. `contracts/events/` and `contracts/redis/` contain no contracts; `contracts/db/` has no raw usage-event or cost-aggregation schema.
- `CONTRIBUTING.md` calls for short-lived branches from `main`, focused PRs, passing CI, and documentation updates for behavior or architecture changes.

## 3. Member 3 stage plan

Stages are dependency-driven. The completion checks below are the exit gates; do not move past a contract gate by inventing field names, persistence rules, or Redis settings.

### Stage 1 — Worker startup foundation — COMPLETE

**What we are doing:** Providing a reliable Worker process that can start, report health, connect to dependencies, expose metrics, and shut down cleanly.

**How we did it:** Added strict TypeScript configuration, startup environment validation, Fastify health/readiness routes, MongoDB/Redis clients and pings, reconnect handling, a separate metrics listener, and graceful shutdown handlers.

**Why:** Event-processing behavior depends on a stable service lifecycle. Kubernetes and operators also need health and metrics endpoints before the Worker can be deployed and monitored.

**Exit evidence:** PR #3 is merged. The Worker tests and local smoke checks are recorded in `STATE.md`. The `0.0.0.0` binding assumption still needs confirmation.

### Stage 2 — Redis Streams event pipeline — IN PROGRESS, CONTRACT REVIEW REQUIRED

**What we are doing:** Consuming Gateway usage events, validating them, storing raw events idempotently, and sending invalid or repeatedly failing events to a dead-letter queue (DLQ).

**How we are doing it:**

1. **Propose and review the usage-event contract.** The current v1 proposal defines version, identity, usage, attribution, and strict unknown-field behavior; agree which Gateway outcomes emit events.
2. **Propose and review the Redis contract.** The current proposal defines the stream/envelope, consumer group, recovery, retry cap, DLQ format, and no-trimming policy.
3. **Propose and review raw-event persistence.** The current proposal uses event ID as MongoDB `_id` for idempotency and leaves TTL unset until retention is decided.
4. **Run the consumer adapter** with group creation at the beginning of the stream, `XAUTOCLAIM` recovery, schema validation, and bounded batches.
5. **Persist before acknowledgement.** A duplicate event is harmless because `_id` is unique; errors remain pending for redelivery.
6. **Route invalid and exhausted events to the DLQ.** The DLQ write and source acknowledgement run atomically; only stable error categories and bounded payload data are retained.
7. **Verify recovery cases:** duplicate delivery, malformed payload, Worker restart, Redis redelivery, MongoDB outage, retry exhaustion, and DLQ handling.
8. **Complete the review and integration gates.** Contract files are still proposals and the Gateway producer is not present in this checkout.

**Why:** Redis Streams provides asynchronous decoupling from the Gateway. Validation and idempotency protect data quality; retries and a DLQ make failures inspectable and recoverable instead of silently losing usage.

**Exit checks:** Valid Gateway events reach MongoDB, duplicate delivery does not create duplicate raw records, invalid/permanently failing entries follow the agreed DLQ policy, and restart/recovery behavior matches the contract.

**Current gate:** Worker-side code is implemented locally against proposed contracts. Contract review, live Gateway compatibility, and Redis/Mongo-backed recovery checks remain before Stage 2 can be called complete or pushed.

### Stage 3 — Cost engine and pricing

**What we are doing:** Calculating per-event AI cost from provider/model usage and pricing data.

**How:** First resolve cost ownership and approve the pricing schema, source/update process, currency/unit, precision, rounding, and handling for unknown models or missing usage. Implement a pure calculation module, then connect it to the event processing path and compare results against agreed examples.

**Why:** Usage counts are not spend until pricing rules are applied consistently and explainably.

**Exit checks:** Reference cases match the agreed calculation rules; unknown pricing does not silently produce a misleading cost; pricing versions/sources can be traced.

### Stage 4 — MongoDB persistence and aggregation

**What we are doing:** Retaining raw events under the agreed retention policy and producing hourly/daily cost rollups.

**How:** Implement the approved raw-event and cost-aggregation schemas, indexes, and TTL settings. Build aggregation jobs over the persisted data for agreed dimensions (such as tenant, team, workload, provider, and model). Ensure jobs can be retried or recomputed safely.

**Why:** Raw records support auditability and reprocessing; rollups keep analytics queries fast.

**Exit checks:** Raw and aggregate totals reconcile for known datasets; retention behaves as specified; duplicate job execution does not inflate totals; representative spend queries return correct values.

### Stage 5 — Control Plane API for analytics

**What we are doing:** Providing stable endpoints that expose spend and usage summaries to the dashboard.

**How:** Coordinate API schemas with Member 2, implement endpoints over the aggregation layer, validate filters and ranges, and add pagination/limits and safe error handling as specified by the API contract.

**Why:** The frontend should read governed API responses instead of accessing MongoDB directly.

**Exit checks:** API responses match the contract, sampled totals reconcile with stored rollups, and query latency is measured against project goals.

### Stage 6 — Budget API and policy/budget integration

**What we are doing:** Enabling budget management and connecting budget state to Gateway enforcement.

**How:** Use the approved budgets schema and API/Redis conventions; implement create/read/update flows and coordinate enforcement behavior with Member 1 and the budget UI with Member 2. Cover threshold and exceeded-budget behavior end-to-end.

**Why:** Spend visibility helps explain usage; budgets help teams act before or when limits are reached.

**Exit checks:** Budget state is persisted and visible through the API/UI, and Gateway behavior for within-limit and exceeded requests matches the agreed contract.

### Stage 7 — Kubernetes workload discovery and identity enrichment

**What we are doing:** Discovering workloads and associating usage with their Kubernetes identity and metadata.

**How:** Agree the ServiceAccount/label/annotation mapping with Gateway and platform stakeholders. Implement a least-privilege Kubernetes watcher and metadata sync path; enrich events only with approved fields.

**Why:** Workload attribution makes spend actionable without manual mapping for every deployment.

**Exit checks:** A test workload is discovered, its identity is mapped consistently into usage data, and access permissions are limited to required Kubernetes resources.

### Stage 8 — Recommendations

**What we are doing:** Generating explainable cost/performance optimization recommendations from usage and aggregation data.

**How:** Start with explicit deterministic rules (for example, comparable usage on a lower-cost model), document assumptions and savings calculation, persist results using the approved recommendations contract, and expose them through the API for Member 2's UI.

**Why:** Recommendations turn historical spend data into possible actions while keeping estimates understandable.

**Exit checks:** Each recommendation has evidence, assumptions, and a reproducible savings estimate; unsupported recommendations are not presented as facts.

### Stage 9 — Deployment and observability

**What we are doing:** Packaging and deploying the Worker and related KubeFin services, then making runtime health and performance visible.

**How:** Add a Worker Dockerfile and local Compose profile only after agreeing which services Compose should run. Add Kubernetes Deployment/Service/probes/configuration, Helm chart and values, resource requests/limits, and scaling after the workload shape is understood. Configure Prometheus discovery/scraping for the Worker metrics endpoint; add Worker metrics for event lag, processing duration, successes, retries, and DLQ counts with low-cardinality labels. Add dashboards/alerts and tracing/log correlation where the team has selected the stack.

**Why:** A working local process is not yet a deployable, monitorable service. Operators need to know whether the Worker is healthy, falling behind, or routing events to the DLQ.

**Exit checks:** Deployment is reproducible; probes reflect readiness; Prometheus can scrape the Worker; metrics and alerts expose queue lag and processing failures; logs contain no payload/PII/secrets.

### Stage 10 — Reliability, security, and final integration

**What we are doing:** Checking that Member 3 components and their integrations behave under realistic failure and operational conditions.

**How:** Coordinate end-to-end checks with Members 1 and 2; test Redis/MongoDB outage and recovery, duplicate events, consumer restarts, cost reconciliation, API behavior, deployment rollback, permissions, secret handling, and relevant load targets. Document runbooks and finalize contract versions.

**Why:** The Worker sits on a financial data path; missed, duplicated, or mispriced events undermine trust in the whole product.

**Exit checks:** Agreed reliability/security criteria pass, operational recovery is documented, and the Member 3-owned system is supportable by the team.

## 4. Working rhythm for each stage

1. Check the current `main`, repository instructions, and relevant contracts before coding.
2. List the stage's inputs, owners, decisions, and exit checks in `STATE.md`.
3. Resolve shared interface decisions through the contract workflow before implementing cross-service behavior.
4. Make one focused change on a short-lived Member 3 branch, limited to Worker, deploy, and any specifically assigned CI paths.
5. Add/update verification appropriate to the change; run the documented build and checks when implementation is ready.
6. Update the README/state/docs affected by the change, open a focused PR, and record integration dependencies.
7. Move to the next stage only when its entry dependencies are satisfied and the previous stage's exit checks are reviewable.

## 5. Immediate next actions

1. Coordinate with Members 1 and 2 to get the usage-event, raw-event, cost-aggregation, and Redis contracts proposed and approved.
2. Resolve event outcomes, idempotency key/index, acknowledgement/retry/DLQ behavior, retention, and cost ownership/precision.
3. Once the contracts are merged, implement Stage 2 in small slices: consumer and validation; persistence/idempotency; retry/DLQ and recovery.
4. Add focused CI coverage for the Worker build/tests and contract validation as part of the relevant implementation/CI work.
5. Start cost calculation only after the pricing and ownership decisions are settled.
