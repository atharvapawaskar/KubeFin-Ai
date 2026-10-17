# Worker State

## Current task
Phase 3 follow-up — replace USD-only pricing outputs with reviewed, currency-aware pricing contracts and amounts.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams pipeline and its event/DB/Redis contracts: merged in PRs #7 and #8.
- Stage 2 unit and contract checks passed. Live Redis/Mongo recovery and Gateway-to-Worker integration were not verified in this environment because the Docker daemon was unavailable and the Gateway service is not present in this checkout.
- Phase 3 USD contract and implementation were merged in PRs #9 and #10. The currency-aware v2 contract proposal is PR #11. At the project owner's direction, its dependent implementation is being prepared on `m3/stage3-currency-implementation`, based on the proposal branch; reviewer feedback on PR #11 must be incorporated before merge.

## Phase 3 design
- Exact provider/model matches use the event's `occurredAt` timestamp and a single effective pricing interval.
- Pricing v2 records store integer micro-units per million input/output tokens, an ISO 4217 currency, effective interval, source URL, and verification time.
- Worker selects one currency per deployment with `PRICING_CURRENCY` (default INR); no automatic FX conversion occurs.
- V2 pricing records carry `pricingVersion: 2`, so lookups cannot mistake legacy USD documents for v2 rates. The index migration is explicit and changes indexes only.
- Cost calculation uses integer arithmetic and retains sub-micro-unit precision; MongoDB stores `costAmount` as Decimal128 with `costCurrency`.
- Each priced event records `pricingStatus: "priced"` and the `pricingRecordId` used.
- If no rate applies in the configured currency, persist raw usage as `pricingStatus: "unpriced"` with no cost fields. Do not invent a price or silently use zero.
- The bounded backfill command handles existing Stage 2 raw events and can reprice unpriced records after a reviewed rate is added; it is dry-run by default.
- Overlapping active rates are treated as a catalog error; the source event remains pending and follows the existing bounded retry/DLQ handling.

## Verification and environment
- Existing Stage 2 test suite previously passed: TypeScript build plus 29 tests.
- Currency implementation checks: TypeScript build and all 40 Worker tests passed when local listener binding was allowed. All 7 JSON contract schemas/examples passed; pricing script syntax and `git diff --check` passed.
- Docker daemon, Redis, and MongoDB live services are unavailable in this environment, so container-backed integration, index migration execution, and invoice reconciliation remain outstanding. The implementation branch is based on current `main` through the currency contract proposal branch.
- No production pricing records are seeded. They must be entered from reviewed, provider-published rate sources before event costs can be considered production-accurate.

## Review gates
- Contract-only PR must be reviewed by both other members (Vedant/M1 and Om/M2) under the shared contract workflow.
- Implementation PR depends on that contract proposal and should remain a draft until contract review and live integration checks are complete.
- Reconcile representative calculated costs against provider bills before marking the accuracy criterion complete.

## Next
1. Complete the implementation review on its dependent branch and incorporate any decisions from PR #11.
2. After the v2 contract is approved and merged, retarget the implementation PR to `main`.
3. Review legacy pricing documents and execute the dry-run-first index migration explicitly.
4. Provision reviewed rates in the selected currency and run live Redis/Mongo checks and billing reconciliation.
5. Ensure Phase 4 aggregates group by currency or use an approved FX policy.
