# Worker and Control Plane State

## Current task
Stage 10 Member 3 reliability, security, and final integration. Stage 8 contract and implementation are merged in PRs #24 and #25; Stage 7 discovery is merged in PR #23.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams consumer, validation, idempotent persistence, and DLQ: merged in PRs #7 and #8.
- Stage 3 currency-aware pricing contracts and Worker implementation: merged in PRs #11 and #13; state follow-up merged in PR #14.
- Stage 4 rollup contracts and Worker aggregation: merged in PRs #15 and #16. PR #16 CI passed.
- Stage 5 currency-safe analytics API contract and Control Plane implementation: merged in PRs #17 and #18.
- Stage 6 currency-aware budget contract and Control Plane API implementation: merged in PRs #20 and #22. Gateway enforcement and dashboard integration remain other-member work.
- Stage 7 opt-in Kubernetes workload discovery: merged in PR #23.
- Stage 8 recommendations contract and implementation: merged in PRs #24 and #25; live data reconciliation and dashboard integration remain outstanding.
- Stage 9 Worker container, Helm deployment, and Prometheus assets: merged in PR #26; CI run #53 passed. Target-cluster rollout remains pending.

## Stage 5 implementation
- Adds `services/control-plane/` with `GET /api/v2/analytics/spend`; keeps the USD-only v1 contract unchanged.
- Requires verified OIDC JWTs with configured issuer, audience, HTTPS JWKS endpoint, and tenant-scope claim. Missing or invalid auth configuration fails closed; tenant filters are checked before MongoDB queries.
- Reads only active Stage 4 generations and returns 503 if any requested window lacks a published generation or changes during the read.
- Uses exact MongoDB Decimal128 sums, serializes amounts as decimal strings, and keeps currencies and priced/unpriced usage separate.
- Validates UTC-aligned ranges (maximum 744 hourly or 366 daily windows), filters, and bounded breakdown pages. Cursor tokens are HMAC-signed and bound to query filters and tenant scope.
- Adds `/healthz`, MongoDB-backed `/readyz`, redacted request logging, bounded concurrent request handling, and an analytics query index.

## Verification
- Control Plane TypeScript build and 14 unit/injection test cases passed.
- Contract PR #17 CI passed; this implementation branch still needs CI verification after opening its PR.
- Live MongoDB aggregations/index creation, deployed OIDC provider and tenant-claim mapping, representative total reconciliation, and dashboard integration remain unverified in this environment.

## Operational follow-up
1. Review and merge the Stage 5 implementation.
2. Configure the deployment's OIDC issuer, audience, JWKS URL, and tenant claim from the identity provider; verify access and tenant isolation against real tokens.
3. Run representative range queries against MongoDB and reconcile totals/series/breakdowns with active Stage 4 documents and raw events.
4. Integrate the endpoint with Member 2's dashboard and measure query latency at the project target.
5. Configure cluster-wide rate limiting at the ingress or API gateway; the service also has a per-process concurrency cap.

## Stage 6 Member 3 implementation
- Adds proposed `budgets.v2.json` and `control-plane-budgets.v2.yaml`: positive exact decimal-string limits plus three-letter currency codes, with tenant scope derived from the verified OIDC principal. Keeps legacy budgets v1 unchanged.
- Implements authenticated create/list/read/update/delete routes at `/api/v2/budgets`, tenant-scoped MongoDB access, a unique scope/currency/period index, bounded signed-cursor pagination, and current daily/monthly spend reporting from raw usage events. Responses include unpriced-event count, spend status, and an as-of timestamp.
- Current-period spend is informational processed usage and can lag Gateway traffic. It does not implement hard enforcement. Gateway enforcement still needs a reviewed Redis counter/key contract plus atomic reservation/settlement semantics with Member 1. Dashboard integration is owned by Member 2.
- The budget v2 contract was merged in PR #20; the dependent Control Plane API implementation was merged in PR #22.

## Stage 6 verification and exit blockers
- Control Plane `npm test` passes, including budget route/auth/pagination and repository tests for tenant scoping, signed cursors, exact decimal spend, and unknown pricing.
- Worker `npm test` passes all 52 tests; `npm run validate:contracts` validates all 10 JSON schemas/examples; `git diff --check` passes.
- MongoDB aggregation/index behavior and OIDC tenant mapping have not been exercised against live services. Gateway Redis enforcement/integration and Member 2 dashboard work remain outstanding, so Stage 6 is not end-to-end complete.

## Stage 7 Member 3 implementation status
- Added opt-in Kubernetes Pod inventory to the Worker. It uses the in-cluster HTTPS API, projected ServiceAccount token and CA, TLS verification, bounded paginated snapshots, incremental watches with bookmark resume, and relists after resource-version expiry. It stores a MongoDB `kubernetes_workloads` inventory keyed by cluster ID, namespace, and Pod UID.
- Only configured tenant/team/workload label values, Pod identity, and owner references are persisted. The Worker requests Kubernetes partial object metadata and does not alter the shared usage-event or raw-event schemas.
- Added a read-only ClusterRole with `list` and `watch` access to Pods. The role must be bound to the actual Worker ServiceAccount in deployment configuration; no namespace/service-account naming assumption has been made.
- Discovery is disabled by default. Enabling it requires a deployment cluster ID, the three identity label keys, and in-cluster or explicitly configured API host. Deleted Pods are marked inactive; the bounded 100,000-Pod snapshot is only repeated when watch recovery requires a relist.
- Stage 7 code merged in PR #23. End-to-end attribution still needs an agreed cluster-wide label convention, Member 1 confirmation that Gateway identity fields use the same mapping, an RBAC binding to the deployed Worker ServiceAccount, and live cluster/MongoDB verification. Large deployments may require namespace-scoped watches.
- PR #23 CI run #42 passed Worker and Control Plane builds/tests plus contract/structure checks. Local Worker build and `git diff --check` passed. Live Kubernetes/MongoDB integration was not run because no configured cluster or database was available.

## Stage 8 Member 3 recommendations implementation
- Existing `recommendations.v1.json` and `/api/v1/recommendations` are USD-only and have no structured evidence or assumptions. They do not match Stage 3/4 multi-currency data or Stage 8's reproducible-estimate exit checks.
- Contract PR #24 adds `recommendations.v2.json` and the authenticated, tenant-scoped `/api/v2/recommendations` API shape. It keeps v1 unchanged.
- The Worker implementation in this worktree adds one deterministic rule: same-provider lower-cost model evaluation for an attributed workload over exactly 30 complete UTC daily windows. It requires active rollup generations and candidate rates that cover every observed day, compares only within the same currency, stores Decimal128 amounts, and records generation/rate evidence and assumptions. It does not claim quality or latency equivalence, switch models, or emit provider/cache recommendations without evidence.
- The Worker CLI previews by default and only upserts on explicit `--apply`. The Control Plane implementation adds an authenticated, tenant-scoped, currency-separated, Decimal128-ranked API with bounded signed cursors.
- Worker TypeScript build and all 57 Worker tests passed (including lifecycle/metrics tests after allowing loopback binds). Control Plane TypeScript build and all 6 tests passed. Local contract validation passed for the 10 existing JSON schemas; PR #24 CI passed the proposed schema, OpenAPI, service, and structure checks. No live MongoDB integration or dashboard integration was run.
- Stage 8 implementation merged in PR #25. Live MongoDB rollup/rate reconciliation and Member 2 dashboard integration remain outstanding; scheduling and recommendation-retention policy also remain deployment decisions.

## Stage 9 Member 3 deployment and observability
- Added a multi-stage Node 24 Alpine Worker image. The runtime runs as the unprivileged Node user, contains production dependencies and built Worker files only, exposes separate application and metrics ports, and has a `/healthz` container health check. `.dockerignore` excludes local dependencies, build output, credentials, and repository metadata.
- Added a Helm chart with a hardened Deployment, startup/liveness/readiness probes, ClusterIP Service, bounded default resources, existing MongoDB/Redis Secret references, and discovery-disabled-by-default behavior. When discovery is enabled, Helm requires the cluster ID and three label keys, enables the ServiceAccount token, and grants only Pod `list`/`watch` RBAC.
- Added Prometheus annotation-based endpoint discovery and alert rules for scrape availability, stream lag, dead-letter events, and processing latency. Worker metrics now include sampled consumer-group lag and per-event processing duration alongside outcome counters; labels remain bounded.
- Root Compose remains limited to MongoDB and Redis per the existing repository CI constraint. No production registry, credentials, namespace label convention, replica target, or public endpoint was invented.
- Worker `npm test` passed all 60 tests; `npm run validate:contracts` validated all 10 schemas/examples; Helm chart values and Prometheus YAML files parsed locally; `git diff --check` passed. Local Helm validation is unavailable because Helm is not installed. Docker image build could not run because no Docker daemon is running. GitHub CI now lints/renders default and discovery-enabled Helm templates and builds the image.
- CI run #52 passed repository structure, Worker and Control Plane tests, contract validation, Helm lint/default+discovery rendering, and the Worker image build. No live Kubernetes, MongoDB, Redis, or Prometheus integration was available. A non-production cluster rollout still needs to verify image pull, real dependency connectivity, readiness, RBAC behavior if discovery is enabled, scrape health, and alert evaluation.

## Stage 10 Member 3 reliability, security, and final integration
- This Stage 10 proposal adds a dedicated CI integration job using disposable MongoDB 7 and Redis 7 services. It exercises the actual Redis Streams and MongoDB adapters through a transient persistence failure, stops the first consumer, and verifies a fresh consumer reclaims and persists the pending event.
- The same integration test checks duplicate event idempotency, exact INR Decimal128 cost for deterministic test rates, invalid-event DLQ metadata without storing/logging prompt content, and source acknowledgement cleanup. The persistence outage is injected at the sink boundary; it validates retry/recovery behavior without claiming a real MongoDB process outage test.
- Deployment CI now checks that rendered defaults retain the chart's non-root, read-only filesystem, no privilege escalation, RuntimeDefault seccomp, and dropped-capability settings. The operations runbook documents deploy/smoke checks, queue and dependency recovery, DLQ handling, rollback, secret/RBAC checks, and cost reconciliation.
- Shared contracts remain unchanged. This implementation uses the merged usage-event and raw-event behavior as it exists; any new contract versions require review from affected members.
- Remaining Stage 10 exit work is environment-dependent: real target-cluster rollout and rollback, actual MongoDB/Redis process outage/failover, Gateway/Control Plane/dashboard end-to-end integration, invoice/sample reconciliation against approved provider prices, and agreed representative load/SLO measurements.
