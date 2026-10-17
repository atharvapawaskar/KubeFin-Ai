# Worker State

## Current task
Stage 4 hourly and daily cost aggregation over persisted usage events.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams consumer, validation, idempotent persistence, and DLQ: merged in PRs #7 and #8.
- Stage 3 currency-aware pricing contracts and Worker implementation: merged in PRs #11 and #13; state follow-up merged in PR #14.
- Stage 4 cost aggregation contracts: merged in PR #15. Worker implementation is prepared for review.

## Stage 4 implementation
- Rebuilds bounded, UTC-aligned hourly or daily windows from `usage_events`.
- Groups by tenant, team, workload, provider, model, currency, and priced/unpriced status. Currency groups remain separate; unpriced totals carry token/event counts but no fabricated amount.
- Uses isolated generation snapshots and a fenced per-window lease. Queries only the generation published by the active window state, so an interrupted rebuild cannot replace a complete snapshot.
- Rejects malformed source events in the selected window before aggregation. Source timestamps are indexed and exact UTC windows use half-open boundaries.
- Provides a dry-run-first CLI. Applying requires explicit `--apply`; generation pruning also requires an explicit past `--prune-before` cutoff and preserves active generations. No TTL or unapproved retention policy is introduced.
- Provides a bounded query helper for active windows/ranges. No HTTP endpoint was added because the current shared Control Plane API remains USD-specific; a currency-aware API requires its own reviewed contract.

## Verification
- Worker TypeScript build and unit suite: 52/52 tests passed with loopback access enabled.
- Contract validation: 9 JSON schemas/examples passed.
- Aggregation CLI syntax and `git diff --check` passed.
- Live MongoDB aggregation, concurrency, and query execution remain unverified because the Docker daemon/MongoDB service is unavailable in this environment.

## Operational follow-up
1. Review and merge the Stage 4 Worker implementation.
2. Run the CLI in dry-run mode, then validate source quality and aggregation results against a representative database before applying.
3. Reconcile hourly/daily event counts, token totals, and per-currency costs with raw events.
4. Decide an explicit retention/cleanup policy before scheduling regular pruning; current pruning is manual and cutoff-based.
5. Have the API owners approve a currency-aware analytics API contract before exposing rollups over HTTP.
