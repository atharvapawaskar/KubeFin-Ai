# Worker State

## Current task
Stage 2 — Redis Streams consumer, validation, raw-event persistence/idempotency, and DLQ. Worker implementation is in progress against proposed v1 contracts in `contracts/events/`, `contracts/db/`, and `contracts/redis/`; these proposals still need the contract reviews required by `CONTRIBUTING.md` before integration is considered approved.

## Decisions
- [Verified] Atharva confirmed the Worker listener configuration: `PORT=3000`, `METRICS_PORT=9090`.
- [Verified] Pin Node with `.nvmrc` to `24.22.0`, the current LTS release according to the Node.js release page checked on 2026-10-17.
- [Verified] Use pinned Fastify, Zod, MongoDB, Redis, TypeScript, and `@prometheus-io/client` packages; the latter replaces deprecated `prom-client` per its upstream README.
- [Assumed] Bind operational listeners to `0.0.0.0` so Kubernetes probes and Prometheus can reach them; recorded in `docs/ASSUMPTIONS.md` for Atharva confirmation.
- [Verified] Member 2's contracts PR #2 is present on `main`, adding the Control Plane API, budgets, and recommendations schemas. `main` still lacks usage-event, raw usage-event, and Redis contracts; this working tree now contains proposed Stage 2 v1 files pending review.
- [Proposed, pending contract review] Usage-event v1 uses a UUID `eventId`, RFC 3339 `occurredAt`, tenant/provider/model identity, and input/output token counts. The Worker stores the event with `_id=eventId` in a regular `usage_events` collection to make duplicate delivery safe through MongoDB's unique `_id` index.
- [Proposed, pending contract review] Redis uses `usage-events`, group `kubefin-worker-v1`, DLQ stream `usage-events:dlq`, payload field `payload`, initial group offset `0`, and no stream trimming until retention is approved.
- [Verified] PR #3 (Worker startup foundation) is merged and closed on GitHub, with merge commit `bc52e1d2b1986cb1d86dc7b6a6eb030e9ac984ac`.
- [Verified] GitHub `main` has only placeholders in `contracts/events/` and `contracts/redis/`, and only budgets/recommendations schemas in `contracts/db/`. This working tree adds draft Stage 2 contract proposals; they are not merged or approved.
- Repository changes for Member 3 are limited to `services/worker/**`, `deploy/**`, and `.github/**`, per the Member 3 brief.

## Done
- [Verified] Inspected the project tree: `services/worker/`, `deploy/docker/`, `deploy/helm/`, and `deploy/k8s/` exist; the Worker and deployment directories contain only `.gitkeep` placeholders.
- [Verified] On `main`, `contracts/events/` and `contracts/redis/` contain only placeholders.
- [Verified] On `main`, `contracts/db/` contains `budgets.v1.json` and `recommendations.v1.json`; no raw usage-event or cost-aggregation schema is present.
- [Verified] The Worker foundation now has strict TypeScript configuration, startup environment validation, health/readiness routes, a separate metrics listener, Redis/Mongo readiness pings, reconnect attempts, and SIGTERM/SIGINT shutdown handling.
- [Verified] `npm test` passed: TypeScript build and all 29 tests, including startup/shutdown, metrics, event validation, MongoDB idempotency, Redis adapter mapping, pending recovery, retry, DLQ, and configuration. The loopback HTTP tests required elevated test permission because the default sandbox denies local listeners.
- [Environment limitation] Redis and MongoDB binaries are not installed and the Docker daemon socket is unavailable, so real Redis/MongoDB integration checks could not run. The Gateway implementation is also absent from this checkout.
- [Verified] `npm ci --ignore-scripts --offline` completed successfully; npm reported zero vulnerabilities.
- [Verified] A live smoke check returned `/healthz` 200, `/readyz` 503 while Redis/Mongo were unavailable, and `/metrics` 200 on the separate port; SIGINT logged clean shutdown. Docker API access was denied, so Compose-backed service verification was not run.
- [Verified] This checkout is on `m3/worker-stage2` at the existing Stage 2 foundation commit `14995c7`; `origin/main` in the local Git cache is stale at the pre-PR4 commit. GitHub reports current `main` at merge commit `e52ecf0`; direct `git fetch` is unavailable in this environment.
- [Implemented locally against proposals] Added the event validator, MongoDB raw-event store, Redis Streams adapter, consumer-group recovery loop, bounded retry/DLQ policy, atomic DLQ-and-ack script, and bounded-cardinality outcome counter. `eventId` is the MongoDB `_id`; write and DLQ failures leave source entries pending. No raw payload or exception text is logged.

## Next
- Obtain the required contract reviews for the v1 event, raw-event, and Redis proposals; adjust the implementation if reviewers change the interfaces.
- Run Redis/Mongo-backed recovery checks in an environment with the Docker daemon available, then push the focused contract and implementation PRs in the repo's required review order.
- Member 3's full stage-by-stage roadmap and verified infrastructure inventory are documented in `MEMBER3-STAGE-GUIDE.md`.

## Stage 2 checklist (blocked pending contracts)
- [Drafted] Usage-event v1 schema, event examples, required/optional fields, and strict unknown-field behavior.
- [Drafted] Producer-to-stream mapping: `usage-events`, `payload` JSON field, group name, initial offset, consumer identity, and current event shape.
- [Drafted] Pending-entry reclaim and acknowledgement after durable persistence or atomic DLQ write.
- [Drafted] Retry cap, DLQ envelope, payload size limit, and no-trimming policy.
- [Drafted] Raw usage-event document, regular collection, unique `_id=eventId`, optional attribution fields, and no TTL until retention is approved.
- [ ] Contract review by all affected members and update based on feedback.
- [ ] Confirm the Gateway emits only the agreed v1 event shape; the Gateway implementation is not present in this checkout.
- [ ] Run Redis/Mongo-backed redelivery, restart, retry exhaustion, and DLQ integration checks.

The checked-in v1 files currently describe proposals for review; they are not yet approved integration contracts. The Worker implementation is intentionally kept local until the contract reviews and end-to-end recovery checks are complete.

## Open questions
- Final ownership of cost calculation (Member 1 proposal assigns it to Member 3; the repo phase plan assigns it to the Worker).
- Whether absent team/workload identifiers are null/omitted in events and how they are represented in storage.
- MongoDB collection type: proposal selects a regular collection to support unique event identity; this differs from the architecture's time-series description and requires review.
- Cost unit, precision, pricing source, and rounding policy.
- Which outcomes produce events, including provider errors and Gateway rejections.
- Approval of Redis consumer-group envelope, retry/DLQ threshold, stream retention/trimming, and producer failure handling proposals.
- Raw event TTL and index agreement; the current draft does not enable TTL.
- Confirm the recorded `0.0.0.0` listener-binding assumption (confirmation requested).

## Stage 2 review gates
- The event schema, Redis names/envelope, raw collection design, retry cap, DLQ format, and retention policy are proposals until reviewed.
- The Gateway producer is absent, so producer failure behavior and live Gateway-to-Worker flow cannot be verified in this checkout.
- Cost ownership and financial precision remain Stage 3/4 decisions; no cost calculation or aggregation is included here.

## UNKNOWN list
- UNKNOWN: Contract review outcome for the proposed usage-event, raw-event, and Redis v1 interfaces.
- UNKNOWN: Gateway producer compatibility and failure/backpressure policy.
- UNKNOWN: Raw-event retention/TTL policy.
- UNKNOWN: Cost ownership, pricing source, precision, and aggregation schema for later stages.
