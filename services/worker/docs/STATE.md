# Worker State

## Current task
Stage 1 — Worker startup foundation. Contract-dependent event processing remains gated on the shared contracts.

## Decisions
- [Verified] Atharva confirmed the Worker listener configuration: `PORT=3000`, `METRICS_PORT=9090`.
- [Verified] Pin Node with `.nvmrc` to `24.22.0`, the current LTS release according to the Node.js release page checked on 2026-10-17.
- [Verified] Use pinned Fastify, Zod, MongoDB, Redis, TypeScript, and `@prometheus-io/client` packages; the latter replaces deprecated `prom-client` per its upstream README.
- [Assumed] Bind operational listeners to `0.0.0.0` so Kubernetes probes and Prometheus can reach them; recorded in `docs/ASSUMPTIONS.md` for Atharva confirmation.
- [Verified] Member 2's contracts PR #2 is present on `main`, adding the Control Plane API, budgets, and recommendations schemas. The proposed usage-event, raw usage-event, cost-aggregation, and Redis key contracts are still absent, so event-processing decisions remain unresolved.
- Repository changes for Member 3 are limited to `services/worker/**`, `deploy/**`, and `.github/**`, per the Member 3 brief.

## Done
- [Verified] Inspected the project tree: `services/worker/`, `deploy/docker/`, `deploy/helm/`, and `deploy/k8s/` exist; the Worker and deployment directories contain only `.gitkeep` placeholders.
- [Verified] `contracts/events/` and `contracts/redis/` exist but contain no contract files.
- [Verified] `contracts/db/` currently contains `budgets.v1.json` and `recommendations.v1.json`; no raw usage-event or cost-aggregation schema is present.
- [Verified] The Worker foundation now has strict TypeScript configuration, startup environment validation, health/readiness routes, a separate metrics listener, Redis/Mongo readiness pings, reconnect attempts, and SIGTERM/SIGINT shutdown handling.
- [Verified] `npm test` passed: strict TypeScript build plus 8 tests, including a startup/readiness/SIGTERM smoke test (run on local Node v24.19.0; `.nvmrc` pins v24.22.0).
- [Verified] `npm ci --ignore-scripts --offline` completed successfully; npm reported zero vulnerabilities.
- [Verified] A live smoke check returned `/healthz` 200, `/readyz` 503 while Redis/Mongo were unavailable, and `/metrics` 200 on the separate port; SIGINT logged clean shutdown. Docker API access was denied, so Compose-backed service verification was not run.
- [Verified] Attached Git metadata from the matching repository checkout to this project root. The local branch `m3/worker-foundation` is based on `main` at `8053c53` and has the `origin` remote configured.

## Next
- Review any further contract updates and record the final decisions listed under Open questions. The current `main` does not yet include the event, raw-event, cost-aggregation, or Redis contracts needed by the Worker consumer.
- Stage 2: build the Redis Streams consumer, validation, and DLQ against the approved event and Redis contracts.

## Open questions
- Final ownership of cost calculation (Member 1 proposal assigns it to Member 3; the repo phase plan assigns it to the Worker).
- Whether absent team/workload identifiers are null/omitted in events and how they are represented in storage.
- MongoDB collection type: time-series per architecture or regular collection to support the proposed unique event index.
- Cost unit, precision, pricing source, and rounding policy.
- Which outcomes produce events, including provider errors and Gateway rejections.
- Redis consumer-group envelope, retry/DLQ threshold, stream retention/trimming, and producer failure handling.
- Raw event TTL and index agreement.
- Confirm the recorded `0.0.0.0` listener-binding assumption (confirmation requested).

## UNKNOWN list
- UNKNOWN: Approved usage-event v1 schema — needed to validate and consume Gateway events — proposed default: use the schema from the approved contracts PR.
- UNKNOWN: Approved raw-event and cost-aggregation schemas — needed for persistence and rollups — proposed default: use the schemas from the approved contracts PR.
- UNKNOWN: Approved Redis stream, group, envelope, retry, DLQ, and retention settings — needed for safe consumption — proposed default: use the conventions from the approved contracts PR.
- UNKNOWN: Approved Worker event-processing and storage contracts — needed for Stage 2 — proposed default: use the merged contracts PR.
