# Worker and Control Plane State

## Current task
Stage 5 analytics API for dashboard spend data.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams consumer, validation, idempotent persistence, and DLQ: merged in PRs #7 and #8.
- Stage 3 currency-aware pricing contracts and Worker implementation: merged in PRs #11 and #13; state follow-up merged in PR #14.
- Stage 4 rollup contracts and Worker aggregation: merged in PRs #15 and #16. PR #16 CI passed.
- Stage 5 currency-safe analytics API contract: merged in PR #17. The Control Plane API implementation is prepared for review.

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
