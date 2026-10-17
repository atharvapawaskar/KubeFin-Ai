# Worker State

## Current task
Stage 2 — Redis Streams consumer, validation, persistence/idempotency, and DLQ. Contract-neutral processing orchestration is in progress; concrete Redis and MongoDB adapters remain gated on approved shared contracts.

## Decisions
- [Verified] Atharva confirmed the Worker listener configuration: `PORT=3000`, `METRICS_PORT=9090`.
- [Verified] Pin Node with `.nvmrc` to `24.22.0`, the current LTS release according to the Node.js release page checked on 2026-10-17.
- [Verified] Use pinned Fastify, Zod, MongoDB, Redis, TypeScript, and `@prometheus-io/client` packages; the latter replaces deprecated `prom-client` per its upstream README.
- [Assumed] Bind operational listeners to `0.0.0.0` so Kubernetes probes and Prometheus can reach them; recorded in `docs/ASSUMPTIONS.md` for Atharva confirmation.
- [Verified] Member 2's contracts PR #2 is present on `main`, adding the Control Plane API, budgets, and recommendations schemas. The proposed usage-event, raw usage-event, cost-aggregation, and Redis key contracts are still absent, so event-processing decisions remain unresolved.
- [Verified] PR #3 (Worker startup foundation) is merged and closed on GitHub, with merge commit `bc52e1d2b1986cb1d86dc7b6a6eb030e9ac984ac`. The local branch remains `m3/worker-foundation` at `f2dda0e` and tracks the matching remote branch.
- [Verified] Latest GitHub `main` contract directories match this checkout: `contracts/events/` and `contracts/redis/` contain only `.gitkeep`; `contracts/db/` contains only `budgets.v1.json` and `recommendations.v1.json`. No open contract PRs were found.
- Repository changes for Member 3 are limited to `services/worker/**`, `deploy/**`, and `.github/**`, per the Member 3 brief.

## Done
- [Verified] Inspected the project tree: `services/worker/`, `deploy/docker/`, `deploy/helm/`, and `deploy/k8s/` exist; the Worker and deployment directories contain only `.gitkeep` placeholders.
- [Verified] `contracts/events/` and `contracts/redis/` exist but contain no contract files.
- [Verified] `contracts/db/` currently contains `budgets.v1.json` and `recommendations.v1.json`; no raw usage-event or cost-aggregation schema is present.
- [Verified] The Worker foundation now has strict TypeScript configuration, startup environment validation, health/readiness routes, a separate metrics listener, Redis/Mongo readiness pings, reconnect attempts, and SIGTERM/SIGINT shutdown handling.
- [Verified] `npm test` passed: strict TypeScript build plus 13 tests, including the startup/readiness/SIGTERM and metrics smoke tests and five delivery-processing tests (run on local Node v24.19.0; `.nvmrc` pins v24.22.0). Loopback binding required elevated test permission because the default sandbox denies local listeners.
- [Verified] `npm ci --ignore-scripts --offline` completed successfully; npm reported zero vulnerabilities.
- [Verified] A live smoke check returned `/healthz` 200, `/readyz` 503 while Redis/Mongo were unavailable, and `/metrics` 200 on the separate port; SIGINT logged clean shutdown. Docker API access was denied, so Compose-backed service verification was not run.
- [Verified] Attached Git metadata from the matching repository checkout to this project root. The local branch `m3/worker-foundation` is based on `main` at `8053c53` and has the `origin` remote configured.
- [Implemented, contract-neutral] Added `src/process-delivery.ts` alongside the existing Worker source modules: validates an injected payload, routes invalid payloads through an injected DLQ writer, idempotently persists valid events through an injected repository, and acknowledges only after the corresponding write succeeds. Transport/storage errors propagate without acknowledgement. The module does not select event fields, Redis keys/groups, MongoDB schema/indexes, retry thresholds, or a DLQ envelope.

## Next
- Resolve the Stage 2 contract checklist below, then implement the Redis Streams and MongoDB adapters against the approved contracts.
- Member 3's full stage-by-stage roadmap and verified infrastructure inventory are documented in `MEMBER3-STAGE-GUIDE.md`.

## Stage 2 checklist (blocked pending contracts)
- [ ] Usage-event v1 schema and representative valid/invalid examples; identify event versioning and unknown-field behavior.
- [ ] Producer-to-stream mapping: stream key, field/envelope names, payload encoding, producer identity, and required event outcomes.
- [ ] Redis consumer-group contract: group and consumer naming, delivery/reclaim behavior, concurrency, and acknowledgement timing.
- [ ] Retry and DLQ contract: retryable versus permanent failures, delivery threshold, DLQ key/envelope, and whether malformed payloads are retained.
- [ ] Stream and DLQ retention/trimming policy, plus producer failure/backpressure expectations.
- [ ] Raw usage-event MongoDB schema, collection type, unique/idempotency key and index definition, optional identifiers representation, and TTL/retention policy.
- [ ] Cost aggregation schema and ownership; cost unit, precision, pricing input/source, and rounding policy before implementing any cost rollup.
- [ ] Confirm whether a successfully persisted event can be acknowledged before/after any downstream aggregation, and define recovery behavior for partial persistence.

The orchestration boundary is implemented without contract assumptions. Concrete consumer, validation schema, persistence/idempotency rule, retry policy, and DLQ serialization still depend on the missing decisions above. This checklist does not establish defaults or schemas.

## Open questions
- Final ownership of cost calculation (Member 1 proposal assigns it to Member 3; the repo phase plan assigns it to the Worker).
- Whether absent team/workload identifiers are null/omitted in events and how they are represented in storage.
- MongoDB collection type: time-series per architecture or regular collection to support the proposed unique event index.
- Cost unit, precision, pricing source, and rounding policy.
- Which outcomes produce events, including provider errors and Gateway rejections.
- Redis consumer-group envelope, retry/DLQ threshold, stream retention/trimming, and producer failure handling.
- Raw event TTL and index agreement.
- Confirm the recorded `0.0.0.0` listener-binding assumption (confirmation requested).

## Stage 2 blocking decisions
- Usage-event schema and event outcomes (including errors/rejections) have no approved contract.
- Redis stream/group envelope, consumer behavior, retry threshold, DLQ representation, retention, and producer failure policy have no approved contract.
- Raw-event schema, collection/index strategy, event uniqueness key, optional identifier representation, and TTL are unspecified.
- Cost aggregation ownership and financial precision/pricing rules are unresolved; do not implement a cost rollup until settled.

## UNKNOWN list
- UNKNOWN: Approved usage-event v1 schema and producer envelope — needed to validate and consume Gateway events.
- UNKNOWN: Approved raw-event and cost-aggregation schemas, idempotency/index strategy, and retention policy — needed for persistence and rollups.
- UNKNOWN: Approved Redis stream/group, acknowledgement/reclaim, retry/DLQ, and retention settings — needed for safe consumption.
- UNKNOWN: Approved Worker event-processing and storage contracts — needed for Stage 2.
