# Redis Streams conventions — Stage 2 proposal

This document proposes the Gateway-to-Worker delivery contract for review. The Gateway and Worker must use the same names and envelope before either implementation is considered integrated.

| Purpose | Name | Convention |
| --- | --- | --- |
| Usage stream | `usage-events` | One stream for the MVP; each entry has one `payload` field containing the UTF-8 JSON usage-event v1 object. |
| Worker group | `kubefin-worker-v1` | Shared consumer group; create with `MKSTREAM` at ID `0` so entries already in the stream are delivered. |
| Dead-letter stream | `usage-events:dlq` | One entry per permanently invalid or exhausted delivery; write the DLQ entry before acknowledging the source entry. |

## Delivery rules

- The Worker acknowledges a source stream entry only after the raw event is durably inserted, recognized as an idempotent duplicate, or its dead-letter record is durably written.
- Use Redis consumer-group pending entries for recovery. Workers reclaim entries that have remained idle for the configured claim interval; successful persistence is idempotent so concurrent redelivery is safe.
- Retry transient Redis or MongoDB failures by leaving the source entry pending. Once the contract's delivery limit is reached, persist a DLQ record before acknowledging the source entry.
- Do not trim the source or DLQ streams in Stage 2. Retention and trimming require an operational decision; trimming before durable processing could lose usage.
- The stream payload must never contain prompts, completions, credentials, or secrets. Logs must not include event payloads or validation values.

## DLQ envelope proposal

Each DLQ stream entry contains `sourceStream`, `sourceEntryId`, `failedAt`, `failureCode`, `attempts`, `payloadBytes`, and `payloadSha256`. Invalid payloads are never copied into the DLQ body; retaining only their size and digest prevents malformed input from smuggling prompts, completions, credentials, or PII into persistent storage. For a valid schema-conforming event that exhausts MongoDB retries, include `payload` only when it is at most 256 KiB so the event can be inspected and replayed safely. `failureCode` is a stable, non-sensitive category; exception messages and validation values are not copied to the DLQ or logs. A Lua script checks that the source entry is still pending, appends the DLQ entry, and acknowledges the source entry atomically so recovery cannot create duplicate DLQ entries after a lost Redis response.

---

## Stage 3 proposal — Real-time budget enforcement keys

This section proposes the Redis key schema, hash tag placement, and Lua atomic scripts for real-time Gateway admission control and Control Plane budget synchronization. Detailed architectural specifications, failure matrices, and proofs are documented in `contracts/redis/rfc-budget-enforcement.md`. Implementation remains blocked pending Atharva Pawaskar's review and team consensus.

### Key schema and hash tag placement

All keys for a given tenant budget scope, currency, and period share the exact same hash tag `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`. This ensures Redis Cluster maps all related keys to the exact same hash slot (0–16383), eliminating `CROSSSLOT` errors during multi-key atomic Lua operations (`reserve_budget.lua`, `settle_budget.lua`, `release_budget.lua`, `quarantine_budget.lua`, `reap_expired_reservations.lua`).

**Canonical Budget Identity Tuple (5 dimensions):**
```
(tenantId, scopeType, scopeId, currency, period)
```
Where `period` ∈ {`daily`, `monthly`} and the UTC window key is derived from the period (`YYYY-MM-DD` for daily, `YYYY-MM` for monthly). This 5-tuple is the canonical partition key for all budget enforcement, spend accounting, and reconciliation. The `amount` field in request records is a per-request value, not a partition dimension.

| Purpose | Pattern | Hash tag slot | Type / Convention |
| --- | --- | --- | --- |
| Budget ceiling | `budget:limit:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `{budget:...}` | String integer. Configured budget limit in integer micro-units (1 currency unit = 1,000,000 micro-units, $100.00 = 100,000,000). Synchronized from MongoDB by Control Plane. |
| Period spend | `budget:spend:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<window>` | `{budget:...}` | String integer. Cumulative settled spend in integer micro-units for UTC period window (`YYYY-MM-DD` for daily, `YYYY-MM` for monthly). TTL: 72h (daily) / 42d (monthly) — window duration plus 24h/7d reconciliation grace period. Expires only after reconciliation marks window `COMPLETE` (see Protocol 6.2 limitations in RFC). |
| In-flight reserved | `budget:reserved:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `{budget:...}` | String integer. Cumulative in-flight reserved micro-units. Incremented on request admission, decremented on settlement/release/reaper. **NO TTL** while any request record for this budget scope is in a non-terminal state (`RESERVED_PRE_DISPATCH`, `DISPATCHED_IN_FLIGHT`, `UNCERTAIN_HELD`, `ORPHANED_DISPATCHED_UNCERTAIN`). If Redis loses the key, reconstruct by summing `amount` from non-terminal `budget:req` records; never silently reset to zero. |
| Request record | `budget:req:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<eventId>` | `{budget:...}` | Hash. Contains `amount` (micro-units), `state` (`RESERVED_PRE_DISPATCH`, `DISPATCHED_IN_FLIGHT`, `RELEASED_PRE_DISPATCH`, `RELEASED_UNBILLED`, `EXPIRED_UNBILLED`, `UNCERTAIN_HELD`, `ORPHANED_DISPATCHED_UNCERTAIN`, `SETTLED`, `RELEASED_RECONCILED`), `createdAt`, `deadlineAt`, `settledCost`, `settledAt`, `releasedAt`, `releaseReason`. **State-gated retention:** Non-terminal states (`RESERVED_PRE_DISPATCH`, `DISPATCHED_IN_FLIGHT`, `UNCERTAIN_HELD`, `ORPHANED_DISPATCHED_UNCERTAIN`) — **NO TTL**; record persists until explicit settlement/release via Lua script. Terminal states (`SETTLED`, `RELEASED_*`, `EXPIRED_UNBILLED`) — window-based TTL (48h daily / 35d monthly) for idempotent late retries. The 15-minute quarantine review deadline is scored in `budget:res_expiry` only; it does NOT trigger key deletion. |
| Active reservation registry | `budget:res_expiry:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `{budget:...}` | Sorted Set. Member: `eventId`. Score: `deadline_timestamp_ms`. Used by active background reaper to safely detect and recover crashed requests without phantom counter leaks. This is an expiry index, NOT a durable inventory — it can contain entries for missing/corrupted request records. |
| Budget metadata | `budget:meta:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `{budget:...}` | Hash. Contains `enforcement` (`hard` / `alert_only`), `alertThresholdPct` (`80`), `unconstrained` (`"1"` or `"0"` or absent). Explicitly authorized bypass flag set by Control Plane; only an authorized administrative principal may write this field. Gateway clients cannot request or override bypass via request parameters or headers. The flag is configuration, not proof of authorization by itself. Behavior: absent or `"0"` = normal enforcement; `"1"` = unconstrained mode (budget limit check skipped, admission always allowed). When `"1"`, all budget dimensions (tenant, scope, currency, period) for that budget scope are bypassed. Audit event `budget_unconstrained_admission_total` emitted on each admission; response header `X-Budget-Mode: unconstrained` included. **Malformed values** (anything other than `"0"` or `"1"`): treated as `"0"` with Prometheus alert `gateway_budget_meta_malformed_total`. |
| Reconciliation control (proposed) | `budget:recon:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<window>` | `{budget:...}` | Hash (proposed). Fields: `status` (`PENDING`/`COMPLETE`/`REBUILD`), `runId`, `lastRunAt`, `mongoAuditedMicros`, `redisHistoricalMicros`, `driftMicros`, `source` (`MONGODB_REBUILD` or `LIVE`). TTL: grace period remaining. Only created if Option A or B from Protocol 6.2 is adopted. |
| Reconciliation lock (proposed) | `budget:recon:lock:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `{budget:...}` | String (Redis `SET NX PX`). Distributed lock for per-scope reconciliation serialization. TTL: 5 minutes (300000ms). Only created if automated reconciliation is adopted. |

### Enforcement & accounting rules

1. **Check-before-capacity reservation idempotency:** `reserve_budget.lua` checks existing request state in `budget:req` before evaluating capacity. Repeating a request with the same ID and parameters returns `ALREADY_RESERVED` without incrementing `budget:reserved`. Mismatched parameters return `CONFLICT_REQUEST_MISMATCH`.
2. **Active reaper lifecycle accounting:** Key expiration does NOT automatically decrement `budget:reserved`. Instead, an active reaper monitors `budget:res_expiry` sorted set, recovers crashed Gateway requests, adjusts `budget:reserved`, and alerts operations without phantom counter leaks.
3. **Exact integer micro-unit arithmetic:** All spend calculations use integer micro-units ($1 \text{ currency unit} = 1,000,000 \mu\text{units}$) and ceiling division. Bound: $1 \le \text{amount} \le 10^{14}$, safely within IEEE-754 53-bit integer mantissa in Lua 5.1 / Redis 6–7.
4. **Missing currency budget fail-closed:** If tenant budget enforcement is active, calling a model whose pricing currency lacks a `budget:limit` key fails closed with HTTP 402 `NO_BUDGET_FOR_CURRENCY`. Missing currency budgets never permit unmetered usage.
5. **Post-dispatch fast settlement & overrun preservation:** Gateway settles reservation to actual integer micro-spend upon provider response. If actual cost exceeds reservation or budget ceiling, the true actual spend is preserved in `budget:spend`, the current request completes, and subsequent requests are blocked.
6. **Worker non-duplication & multi-dimensional reconciliation:** Worker persists exact `Decimal128` costs into MongoDB `usage_events` without incrementing Redis counters. **Automated reconciliation is not yet specified — see Protocol 6.2 in RFC for design limitations and open decisions (Option A/B/C).** Current contract only defines read-only drift detection. Manual repair procedure required until design is approved.
7. **Ambiguous timeout quarantine:** Provider timeouts (HTTP 504) and dropped connections transition request to `UNCERTAIN_HELD` with a 15-minute safety window in `budget:reserved`. Reservations are never released to zero immediately when provider billing is uncertain.
