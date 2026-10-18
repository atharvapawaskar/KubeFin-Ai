# Member 3 (Atharva) — Stage-by-Stage Guide

This guide scopes the KubeFin AI roadmap to Member 3's Worker and DevOps responsibilities. It distinguishes checked-in configuration from future architecture plans. Shared contracts are owned by all members; the Stage 3 currency v2 proposal is PR #11, and this implementation is being developed on a dependent branch against that proposal.

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
- A separate metrics listener serves only `GET /metrics`, collects default process/runtime metrics, and exposes a bounded-cardinality usage-event outcome counter. Event lag and processing-duration metrics have not been added.
- Redis reconnect handling, graceful SIGTERM/SIGINT shutdown, the Stage 2 Redis Streams consumer, validation, idempotent MongoDB persistence, retries, and DLQ handling are implemented and merged.

The root `.env.example` includes MongoDB/Redis URLs, Worker stream settings, `PRICING_CURRENCY=INR`, a generic `PORT=3000`, `NODE_ENV`, optional provider-key placeholders, and feature flags. Do not put secrets in the repository.

### Kubernetes, Helm, Prometheus, and other observability

- `deploy/k8s/`, `deploy/helm/`, and `deploy/docker/` currently contain only `.gitkeep` placeholders.
- There are no Kubernetes Deployments, Services, probes, ConfigMaps/Secrets templates, Helm values, HPA, or ingress resources in the repository.
- There is no Prometheus configuration, ServiceMonitor, scrape annotation, Grafana dashboard, alert rule, Loki setup, or OpenTelemetry tracing setup.
- The architecture document describes these as planned production capabilities, not as already deployed configuration.
- The Worker exposes a metrics endpoint that a future Prometheus configuration can scrape; exposing `/metrics` alone does not configure Prometheus discovery or a dashboard.

### CI, contracts, and collaboration

- `.github/workflows/ci.yml` checks repository structure, validates JSON contracts, and builds/tests the Worker.
- `.github/CODEOWNERS` assigns Worker and deploy paths to Member 3. Shared contracts and architecture documentation involve all three members.
- Contract workflow in `contracts/README.md` requires a contract-only PR. Stage 2 event, raw-event, and Redis contracts are merged; the Stage 3 currency-aware v2 proposal is open as PR #11. The owner authorized preparing the dependent implementation while the proposal is under review.
- Current contracts include the Control Plane API, budgets, recommendations, Stage 2 usage-event and Redis definitions, and Stage 3 pricing v1. Cost aggregation is a later phase.
- `CONTRIBUTING.md` calls for short-lived branches from `main`, focused PRs, passing CI, and documentation updates for behavior or architecture changes.

## 3. Member 3 stage plan

Stages are dependency-driven. The completion checks below are the exit gates; do not move past a contract gate by inventing field names, persistence rules, or Redis settings.

### Stage 1 — Worker startup foundation — COMPLETE

**What we are doing:** Providing a reliable Worker process that can start, report health, connect to dependencies, expose metrics, and shut down cleanly.

**How we did it:** Added strict TypeScript configuration, startup environment validation, Fastify health/readiness routes, MongoDB/Redis clients and pings, reconnect handling, a separate metrics listener, and graceful shutdown handlers.

**Why:** Event-processing behavior depends on a stable service lifecycle. Kubernetes and operators also need health and metrics endpoints before the Worker can be deployed and monitored.

**Exit evidence:** PR #3 is merged. The Worker tests and local smoke checks are recorded in `STATE.md`. The `0.0.0.0` binding assumption still needs confirmation.

### Stage 2 — Redis Streams event pipeline — IMPLEMENTED, MERGED

**What we are doing:** Consuming Gateway usage events, validating them, storing raw events idempotently, and sending invalid or repeatedly failing events to a dead-letter queue (DLQ).

**How we are doing it:**

1. **Propose and review the usage-event contract.** The current v1 proposal defines version, identity, usage, attribution, and strict unknown-field behavior; agree which Gateway outcomes emit events.
2. **Propose and review the Redis contract.** The current proposal defines the stream/envelope, consumer group, recovery, retry cap, DLQ format, and no-trimming policy.
3. **Propose and review raw-event persistence.** The current proposal uses event ID as MongoDB `_id` for idempotency and leaves TTL unset until retention is decided.
4. **Run the consumer adapter** with group creation at the beginning of the stream, `XAUTOCLAIM` recovery, schema validation, and bounded batches.
5. **Persist before acknowledgement.** A duplicate event is harmless because `_id` is unique; errors remain pending for redelivery.
6. **Route invalid and exhausted events to the DLQ.** The DLQ write and source acknowledgement run atomically; only stable error categories and bounded payload data are retained.
7. **Verify recovery cases:** duplicate delivery, malformed payload, Worker restart, Redis redelivery, MongoDB outage, retry exhaustion, and DLQ handling.
8. **Integration verification remains.** Run Redis/Mongo-backed recovery checks with the Gateway producer when that service is available.

**Why:** Redis Streams provides asynchronous decoupling from the Gateway. Validation and idempotency protect data quality; retries and a DLQ make failures inspectable and recoverable instead of silently losing usage.

**Exit checks:** Valid Gateway events reach MongoDB, duplicate delivery does not create duplicate raw records, invalid/permanently failing entries follow the agreed DLQ policy, and restart/recovery behavior matches the contract.

**Current status:** The Stage 2 contracts and Worker implementation were merged in PRs #7 and #8. Unit and contract checks passed. Live Redis/Mongo recovery and Gateway compatibility were not verified in this environment.

### Stage 3 — Cost engine and pricing

**What we are doing:** Calculating per-event AI cost from provider/model usage and versioned pricing data.

**How:** Use a versioned MongoDB pricing contract with exact provider/model/currency matching and effective intervals. The currency-aware v2 contract accepts ISO 4217 codes; `PRICING_CURRENCY` chooses the Worker deployment currency (default INR). Store rate integers as micro-units of that currency per million tokens. Calculate with integer arithmetic and store `costAmount` as Decimal128 with `costCurrency`. There is no automatic FX conversion; downstream aggregation must group by currency or apply a separately reviewed conversion policy. Persist events without a matching rate as `unpriced`; never substitute zero or a guessed price.

**Current implementation:** Merged in PR #13, with state follow-up in PR #14. Currency-aware pricing, provenance, explicit unpriced handling, migration/backfill tooling, and test coverage are in place. Live Redis/Mongo integration, reviewed rate provisioning, migration execution, and provider billing reconciliation remain outstanding.

**Why:** Usage counts are not spend until pricing rules are applied consistently and explainably.

**Exit checks:** The contract is approved by both other members; unit/reference calculation cases pass; rate intervals cannot overlap within a provider/model/currency; costs identify their pricing record and currency; unmatched records remain visible as unpriced; live Redis/Mongo integration and provider billing reconciliation are verified after rates are populated.

### Stage 4 — MongoDB cost aggregation — IMPLEMENTED, CONTRACT MERGED

**What we are doing:** Producing hourly and daily cost/usage summaries from the persisted, priced or unpriced usage events.

**How:** PR #15 merged the shared `cost_aggregations` and `cost_aggregation_windows` contracts. The Worker CLI accepts an explicit UTC range and granularity, previews by default, and requires `--apply` to connect to MongoDB. Each window is rebuilt into a new generation under a fenced lease; the active pointer changes only after the full aggregation succeeds. Reads use only the published generation. Dimensions include tenant, team, workload, provider, model, currency, and pricing status. Amounts in different currencies remain separate; unpriced events contribute counts and tokens without a made-up cost. Explicit generation pruning is available only with a past cutoff; no automatic TTL/retention behavior is assumed.

**Why:** Rollups make spend analytics efficient while generation swaps keep readers on a complete snapshot during retries or rebuilds. Currency separation preserves monetary meaning.

**Current implementation:** The Stage 4 contracts and Worker aggregation were merged in PRs #15 and #16. The current USD-only Control Plane API was left unchanged; exposing currency-separated rollups over HTTP required a separately reviewed API contract.

**Verification:** TypeScript build and all 52 Worker tests passed with local loopback access; all 9 JSON contract schemas/examples validated; CLI syntax and `git diff --check` passed. Live MongoDB aggregation/concurrency and reconciliation could not be verified because MongoDB/Docker is unavailable in this environment.

**Exit checks:** Review/merge the implementation; run against representative MongoDB data; reconcile event counts, token totals, and each currency independently; validate concurrent/repeated rebuilds and active-generation queries; agree an explicit retention policy before scheduling cleanup. A dashboard/API endpoint is a later stage with its own shared API contract.

### Stage 5 — Control Plane API for analytics — CONTRACT MERGED, IMPLEMENTATION IN REVIEW

**What we are doing:** Providing an authenticated API that exposes currency-safe spend totals, time series, and optional breakdowns to the dashboard.

**How:** The shared v2 API contract was reviewed and merged in PR #17. The new `services/control-plane/` service verifies OIDC bearer tokens against a configured HTTPS JWKS endpoint, derives tenant scope from a configured claim, and queries only the active Stage 4 aggregation generations. It validates half-open UTC ranges and supported filters, preserves currency and priced/unpriced groups, serializes exact decimal amounts, and provides bounded, signed breakdown pagination. It includes liveness/readiness routes, safe errors, redacted request logs, and a per-process concurrency cap. The existing v1 API remains unchanged.

**Why:** The frontend should read governed API responses instead of accessing MongoDB directly.

**Current implementation:** The API service, CI job, environment example, and docs are prepared for implementation review. Unit and injection tests cover query validation, currency separation, tenant isolation, JWT verification, signed cursors, readiness, and concurrency. Live MongoDB aggregations/index creation, deployed identity-provider configuration, dashboard integration, representative reconciliation, and latency measurements still need environment-backed verification.

**Exit checks:** CI passes; API responses match the contract; token verification and tenant isolation are verified with the deployment's identity provider; sampled totals reconcile with active Stage 4 rollups; Member 2 integrates the endpoint; and query latency is measured against project goals.

### Stage 6 — Budget API and policy/budget integration

**What we are doing:** Enabling budget management and connecting budget state to Gateway enforcement.

**How:** Use the approved budgets schema and API/Redis conventions; implement create/read/update flows and coordinate enforcement behavior with Member 1 and the budget UI with Member 2. Cover threshold and exceeded-budget behavior end-to-end.

**Why:** Spend visibility helps explain usage; budgets help teams act before or when limits are reached.

**Exit checks:** Budget state is persisted and visible through the API/UI, and Gateway behavior for within-limit and exceeded requests matches the agreed contract.

### Stage 7 — Kubernetes workload discovery and identity enrichment

**What we are doing:** Discovering Kubernetes Pods and maintaining a metadata inventory that can support consistent tenant, team, and workload attribution.

**How:** The Worker uses projected ServiceAccount credentials over verified HTTPS, obtains a bounded paginated Pod snapshot, then maintains it with incremental watch events and bookmark-based resource-version recovery. Only configured label values map to the existing `tenantId`, `teamId`, and `workloadId` fields; arbitrary labels and pod specs are not stored. Discovery is disabled by default and requires an explicit cluster ID and label-key configuration. A read-only ClusterRole grants only Pod list/watch. Do not alter shared event or raw-event contracts or treat inventory as Gateway attribution until Member 1 confirms the same label mapping.

**Why:** Workload attribution makes spend actionable without manual mapping for every deployment.

**Current status:** The Member 3 Worker discovery implementation and RBAC role are prepared in this PR. The project has not selected a cluster-wide label convention, bound the role to the actual Worker ServiceAccount, or verified discovery on a live cluster. Gateway event attribution and shared mapping confirmation remain cross-member integration work.

**Exit checks:** The Gateway and Worker use an agreed identity mapping, a test workload is discovered and appears in usage attribution, RBAC is bound and verified as least privilege, and live recovery behavior is checked in a Kubernetes/MongoDB environment.

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
3. Resolve shared interface decisions through the contract workflow before merging cross-service behavior. Owner-authorized preparation may proceed on a dependent branch against a clearly identified proposal.
4. Make one focused change on a short-lived Member 3 branch, limited to Worker, deploy, and any specifically assigned CI paths.
5. Add/update verification appropriate to the change; run the documented build and checks when implementation is ready.
6. Update the README/state/docs affected by the change, open a focused PR, and record integration dependencies.
7. Move to the next stage only when its entry dependencies are satisfied and the previous stage's exit checks are reviewable.

## 5. Immediate next actions

1. Review and merge the Stage 5 Control Plane API implementation.
2. Configure real OIDC settings and verify tenant isolation with valid and invalid tokens.
3. Run representative API ranges against MongoDB and reconcile each currency/status group with published Stage 4 rollups.
4. Integrate the endpoint with Member 2's dashboard and measure query latency.
5. Configure cluster-wide rate limiting at the ingress or API gateway; the service's concurrency cap is process-local.
