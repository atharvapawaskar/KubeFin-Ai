# Worker and Control Plane State

## Current task
Stage 7 Kubernetes workload discovery groundwork.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams consumer, validation, idempotent persistence, and DLQ: merged in PRs #7 and #8.
- Stage 3 currency-aware pricing contracts and Worker implementation: merged in PRs #11 and #13; state follow-up merged in PR #14.
- Stage 4 rollup contracts and Worker aggregation: merged in PRs #15 and #16. PR #16 CI passed.
- Stage 5 currency-safe analytics API contract: merged in PR #17. The Control Plane API implementation is prepared for review.
- Stage 6 currency-aware budget contract and Control Plane API: merged in PRs #20 and #22. Gateway enforcement and dashboard integration remain Member 1 and Member 2 work.

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
- The budget v2 contract was merged in PR #20, and the dependent API implementation was merged in PR #22.

## Stage 6 verification and exit blockers
- Control Plane `npm test` passes, including budget route/auth/pagination and repository tests for tenant scoping, signed cursors, exact decimal spend, and unknown pricing.
- Worker `npm test` passes all 52 tests; `npm run validate:contracts` validates all 10 JSON schemas/examples; `git diff --check` passes.
- MongoDB aggregation/index behavior and OIDC tenant mapping have not been exercised against live services. Gateway Redis enforcement/integration and Member 2 dashboard work remain outstanding, so Stage 6 is not end-to-end complete.

## Stage 7 Member 3 implementation status
- Added opt-in Kubernetes Pod inventory to the Worker. It uses the in-cluster HTTPS API, projected ServiceAccount token and CA, TLS verification, bounded paginated snapshots, incremental watches with bookmark resume, and relists after resource-version expiry. It stores a MongoDB `kubernetes_workloads` inventory keyed by cluster ID, namespace, and Pod UID.
- Added a read-only ClusterRole with `list` and `watch` access to Pods. The role must be bound to the actual Worker ServiceAccount in deployment configuration; no namespace/service-account naming assumption has been made.
- Only configured tenant/team/workload label values, Pod identity, and owner references are persisted. The Worker requests Kubernetes partial object metadata and does not alter the shared usage-event or raw-event schemas.
- Discovery is disabled by default. Enabling it requires a deployment cluster ID, the three identity label keys, and in-cluster or explicitly configured API host. Deleted Pods are marked inactive; the bounded 100,000-Pod snapshot is repeated only when watch recovery requires a relist.
- Stage 7 is not complete end to end: the team has not agreed on a cluster-wide label convention; Member 1 has not confirmed that the Gateway derives the existing event identity fields from the same labels; RBAC binding and live cluster verification remain pending. Large deployments may require namespace-scoped watches.
- Verification this turn: Worker TypeScript build and `git diff --check` passed locally. Automated tests and live Kubernetes/MongoDB integration were not run.
