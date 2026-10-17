# Worker State

## Current task
Stage 3 currency-aware cost calculation and persistence.

## Stage status
- Stage 1 Worker startup foundation: merged in PR #3.
- Stage 2 Redis Streams consumer, validation, idempotent persistence, and DLQ: merged in PRs #7 and #8.
- Stage 3 currency-aware pricing contracts and Worker implementation: merged to `main` in PRs #11 and #13.
- Stage 3 implementation includes deployment-selected ISO currency (`PRICING_CURRENCY`, default INR), effective-dated v2 provider/model rates, exact cost arithmetic, Decimal128 amounts with currency and pricing provenance, and safe migration/import/backfill tools.

## Stage 3 behavior
- Rate lookup matches provider, model, configured currency, pricing version, and event time.
- Rates use integer micro-units per million tokens. The Worker does not perform implicit FX conversion.
- Priced events store `costAmount`, `costCurrency`, `pricingStatus: "priced"`, and the source `pricingRecordId`.
- When no applicable configured-currency rate exists, the event remains `unpriced` with no fabricated cost.
- Overlapping effective pricing intervals fail closed as a catalog error.
- The index migration is dry-run by default and changes indexes only. The bounded backfill is also dry-run by default.

## Verification
- Worker TypeScript build and test suite: 40/40 tests passed.
- Contract validation: 7 JSON schemas/examples passed.
- Pricing script syntax checks and `git diff --check` passed.
- Live Docker/MongoDB/Redis integration, execution of the index migration against real data, production rate loading, and invoice reconciliation have not been completed in this environment.

## Operational follow-up
1. Review existing pricing documents and run the migration in dry-run mode, then explicitly apply it during a planned deployment.
2. Load rates from verified provider-published sources for each configured currency; no production rates are seeded by this change.
3. Run live Redis/MongoDB recovery and persistence checks in the deployment environment.
4. Reconcile representative costs against provider invoices before treating cost accuracy as production-validated.
5. Ensure downstream aggregation groups by currency or follows a separately approved FX policy.
