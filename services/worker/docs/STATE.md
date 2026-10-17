# Worker State

## Current task
Phase 3 — per-event token cost calculation from a reviewed, effective-dated pricing catalog.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams pipeline and its event/DB/Redis contracts: merged in PRs #7 and #8.
- Stage 2 unit and contract checks passed. Live Redis/Mongo recovery and Gateway-to-Worker integration were not verified in this environment because the Docker daemon was unavailable and the Gateway service is not present in this checkout.
- Phase 3 pricing contract is proposed in PR #9; review was requested from Vedant (M1) and Om (M2). The implementation is being published as a dependent draft PR. Pricing-source policy is proposed as manually curated rates from provider-published pages; both reviewers must approve the shared contract.

## Phase 3 design
- Exact provider/model matches use the event's `occurredAt` timestamp and a single effective pricing interval.
- Pricing records store USD integer micro-dollars per million input/output tokens, the effective interval, source URL, and verification time.
- Cost calculation uses integer arithmetic and retains sub-micro-dollar precision; MongoDB stores `cost_usd` as Decimal128.
- Each priced event records `pricingStatus: "priced"` and the `pricingRecordId` used.
- If no rate applies, persist raw usage as `pricingStatus: "unpriced"` with no `cost_usd`. Do not invent a price or silently use zero.
- The bounded backfill command handles existing Stage 2 raw events and can reprice unpriced records after a reviewed rate is added; it is dry-run by default.
- Overlapping active rates are treated as a catalog error; the source event remains pending and follows the existing bounded retry/DLQ handling.

## Verification and environment
- Existing Stage 2 test suite previously passed: TypeScript build plus 29 tests.
- Stage 3 Worker tests passed: TypeScript build and 39 tests. Contract validation passed for all 5 JSON schemas/examples; pricing script syntax and `git diff --check` passed.
- Docker daemon, Redis, and MongoDB live services are unavailable in this environment, so container-backed integration and invoice reconciliation remain outstanding.
- No production pricing records are seeded. They must be entered from reviewed, provider-published rate sources before event costs can be considered production-accurate.

## Review gates
- Contract-only PR must be reviewed by both other members (Vedant/M1 and Om/M2) under the shared contract workflow.
- Implementation PR depends on that contract proposal and should remain a draft until contract review and live integration checks are complete.
- Reconcile representative calculated costs against provider bills before marking the accuracy criterion complete.

## Next
1. Run the Worker build/tests and contract validator.
2. Open the contract-only proposal and dependent implementation PR.
3. Obtain M1 and M2 contract review, then update the implementation to any agreed changes.
4. Provision the reviewed rate catalog and run live Redis/Mongo and billing reconciliation checks.
5. Proceed to Phase 4 cost aggregation after these Phase 3 exit checks.
