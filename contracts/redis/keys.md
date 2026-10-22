# Canonical Redis Key Contract

> [!IMPORTANT]
> **Contract Authority & Task 3.2 Status:** This document is the canonical contract for Redis key structures, data types, physical naming conventions, cluster hash-tagging rules, and ownership across Kubefin.
> Task 3.2 (Redis Budget Counter Contract & Real-Time Budget Enforcement) remains **BLOCKED** pending satisfaction of pre-implementation gates (stream migration plan, manual repair fencing runbook, test verification). Architectural consensus between M1 and M3 is established in RFC v0.5.0 on missing-budget policy, Option C reconciliation, and cluster stream hash tags in principle. All Stage 3 budget enforcement keys remain `PROPOSED` until supported by implementation and test evidence. Only Rate Limiting and Stage 2 Usage Event Stream keys are currently `IMPLEMENTED`.

---

## 1. Purpose and Scope

This contract defines the physical Redis key naming conventions, storage schemas, identity dimensions, TTL/expiry behaviors, Redis Cluster sharding policies, and service ownership boundaries for the Kubefin platform.

### Scope
- **Rate Limiting (Gateway M1):** Tenant request rate limiting counters (`IMPLEMENTED`).
- **Event Streaming & Ingestion (Gateway M1 & Worker M3):** Stage 2 usage event streams, consumer groups, and dead-letter queues (`IMPLEMENTED`).
- **Budget Enforcement (Gateway M1 & Control Plane M2):** Currency-specific real-time budget limits, spend counters, reservation counters, request records, reservation expiry sorted sets, and metadata hashes (`PROPOSED`).
- **Reconciliation & Drift Correction (Worker M3 / Shared):** Ledger reconciliation status keys and locks (`PROPOSED` — Option C agreed).

### Out of Scope
- Usage event JSON payload schema (owned exclusively by [`contracts/events/usage-event.v1.json`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/contracts/events/usage-event.v1.json)).
- Budget document database persistence schema (owned exclusively by [`contracts/db/budgets.v2.json`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/contracts/db/budgets.v2.json)).
- Control plane REST/OpenAPI contract (owned exclusively by `contracts/api/control-plane-budgets.v2.yaml`).

---

## 2. Contract Status and Evidence Rules

To avoid confusing planned architecture with running code, every Redis key in this document is tagged with one of three verifiable statuses:

1. `IMPLEMENTED`: The key is actively used in the codebase. Verified against source files in `services/gateway` or `services/worker`.
2. `PROPOSED`: The key is part of the approved design baseline in [`contracts/redis/rfc-budget-enforcement.md`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/contracts/redis/rfc-budget-enforcement.md), but implementation is blocked pending team sign-off.
3. `UNRESOLVED`: The key design has identified architectural gaps, conflicting proposals, or requires upstream M3 design consensus before it can be finalized.

### Evidence Standard
- Key templates must reflect literal strings found in code or approved RFC Lua scripts.
- Keys must not be marked `IMPLEMENTED` based solely on roadmap notes, RFC text, or speculative tests.

---

## 3. Naming Conventions and Placeholders

All Redis keys in Kubefin adhere to hierarchical colon-delimited namespacing:
`<domain>:<entity>[:{<hash-tag>}][:<identifier>...]`

### Canonical Placeholders
- `<tenantId>`: Unique identifier for a tenant (alphanumeric string, e.g., `acme-corp`).
- `<scopeType>`: Budget scope level. Exactly one of: `tenant`, `team`, or `workload`.
- `<scopeId>`: Identifier of the scoped entity. When `<scopeType>` is `tenant`, `<scopeId>` **must equal** `<tenantId>`. When `team` or `workload`, it matches the respective entity ID.
- `<currency>`: Standard 3-letter ISO 4217 uppercase currency code (e.g., `USD`, `INR`). Kubefin enforces single-currency budget scopes; FX conversion is strictly prohibited in Redis.
- `<period>`: Budget time window period. Exactly one of: `daily` or `monthly`.
- `<window>`: UTC period window string:
  - Daily: `YYYY-MM-DD` (e.g., `2026-10-22`)
  - Monthly: `YYYY-MM` (e.g., `2026-10`)
- `<windowIndex>`: Fixed-window unix timestamp index computed as `Math.floor(Date.now() / windowMs)`.
- `<eventId>`: Canonical UUID v4 identifying a unique billable provider call (`contracts/events/usage-event.v1.json`).

---

## 4. Redis Cluster Hash-Tag and Atomicity Rules

### Cluster Slot Hash-Tag Requirement
Redis Cluster determines key sharding via CRC16 of the key name or, if present, the substring enclosed within curly braces `{...}`. Multi-key Lua scripts and atomic transactions (`MULTI`/`EXEC`) fail with a `CROSSSLOT Keys in request don't hash to the same slot` error if all evaluated keys do not map to the identical hash slot.

### Budget Enforcement Hash-Tag Baseline
All keys associated with a specific budget scope use the identical hash tag containing the canonical 5-tuple:
```text
{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}
```

Every multi-key Lua script in Stage 3 (`reserve_budget.lua`, `mark_dispatched.lua`, `settle_budget.lua`, `release_budget.lua`, `reap_expired_reservations.lua`) evaluates keys containing this exact hash tag, guaranteeing co-location on the same Redis Cluster node.

### Cross-Slot Hazards and Architectural Rules
1. **Budget Multi-Key Operations:** Every key accessed in a budget Lua script **must** contain `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`. No un-tagged or differently-tagged keys may be passed.
2. **Rate Limiting:** Single-key evaluation (`INCR` + conditional `PEXPIRE`). Hash-tagging is not required for standalone rate-limiting, but if combined with other tenant keys in the future, `{tenant:<tenantId>}` must be used.
3. **Stage 2 Stream Cluster Hash-Tagging (Agreed in Principle):** The Worker Lua script `deadLetterAndAckScript` evaluates `KEYS[1] = usage-events` (slot 1745) and `KEYS[2] = usage-events:dlq` (slot 14521). In single-node Redis, this executes atomically, but in Redis Cluster it fails with `CROSSSLOT`.
   - **Agreed Decision:** M1 and M3 agree in principle to standardize stream keys on the shared hash tag `{usage-events}`:
     - Primary stream: `{usage-events}`
     - DLQ stream: `{usage-events}:dlq`
     - Both keys hash to slot 1745 (`CRC16("usage-events") mod 16384`), preserving atomic script execution in Redis Cluster.
   - **Migration & Rollback Safeguards:** An operational cutover and rollback procedure must be documented and agreed before deployment to ensure no pending messages in `usage-events` are orphaned. In current running code, stream keys remain `usage-events` and `usage-events:dlq` until the migration deployment plan is executed.

---

## 5. Canonical Key Inventory

| Logical Name | Physical Key Template | Redis Type | Status | Owner | Primary Lifecycle / TTL |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tenant Rate Limit Counter** | `ratelimit:tenant:<tenantId>:<windowIndex>` | `STRING` | `IMPLEMENTED` | Gateway | Ephemeral (`windowMs * 2` ms via `PEXPIRE`) |
| **Usage Events Stream** | `usage-events` | `STREAM` | `IMPLEMENTED` | Gateway / Worker | Durable append-only log; retention unconfigured |
| **Usage Events Dead-Letter Stream** | `usage-events:dlq` | `STREAM` | `IMPLEMENTED` | Worker | Durable DLQ log; retention unconfigured |
| **Budget Limit** | `budget:limit:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `STRING` | `PROPOSED` | Control Plane | Static configuration; persistent until deleted/updated |
| **Budget Spend Counter** | `budget:spend:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<window>` | `STRING` | `PROPOSED` | Gateway | Window-partitioned; 72h (daily) / 42d (monthly) TTL |
| **Budget Reserved Counter** | `budget:reserved:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `STRING` | `PROPOSED` | Gateway | Non-expiring while active reservations exist |
| **Budget Request Record** | `budget:req:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<eventId>` | `HASH` | `PROPOSED` | Gateway | State-gated; persistent in-flight, window TTL terminal |
| **Reservation Expiry Index** | `budget:res_expiry:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `ZSET` | `PROPOSED` | Gateway | Active index; members removed on settlement/release |
| **Budget Metadata** | `budget:meta:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `HASH` | `PROPOSED` | Control Plane | Static configuration; persistent until deleted/updated |
| **Reconciliation Audit Record** | `budget:recon:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<window>` | `STRING` | `PROPOSED` | Worker / Ops | Option C agreed; read-only drift watermark & manual repair audit record |
| **Reconciliation Lock** | `budget:recon:lock:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` | `STRING` | `PROPOSED` | Worker / Ops | Option C agreed; scope-wide distributed lock for manual repair with write fencing |

---

## 6. Detailed Key Definitions

### 6.1 Tenant Rate Limit Counter

1. **Logical name:** Tenant Rate Limit Counter
2. **Physical key template:** `ratelimit:tenant:<tenantId>:<windowIndex>`
3. **Purpose:** Tracks cumulative HTTP request counts per tenant within a rolling fixed-window to enforce gateway ingress rate limits.
4. **Owner:** Gateway (`services/gateway/src/middleware/rate-limit.ts`).
5. **Redis type:** `STRING` (integer counter).
6. **Stored-value format:** Base-10 integer string representation of the request count (e.g., `"42"`). Mutated via `INCR` or Lua `redis.call('INCR', KEYS[1])`.
7. **Identity dimensions:**
   - `<tenantId>`: Attributed tenant ID.
   - `<windowIndex>`: Window index calculated as `Math.floor(Date.now() / windowMs)`.
8. **Cluster hash tag:** None in current implementation. Evaluated as a single-key operation.
9. **Time representation:** Window index based on unix epoch milliseconds (`Date.now()`). Window size is configured by `windowMs` (default: 60,000 ms).
10. **Initialization rules:** Lazily initialized on the first request in the window via `INCR`. If return value is `1`, `PEXPIRE` is set to `windowMs * 2`.
11. **Lifecycle and expiry:** Automatically reclaimed by Redis via TTL. Expiry is set to `windowMs * 2` (default: 120,000 ms) to allow safe overlap checks.
12. **Idempotency and uniqueness:** Non-idempotent counter. Every incoming request increments the counter.
13. **Failure behavior:**
    - If `failureMode === 'fail-closed'` (default): Gateway rejects requests with HTTP 429/500 if Redis is unreachable or returns an error.
    - If `failureMode === 'fail-open'`: Gateway permits requests with `degraded: true` logged.
14. **Evidence/status:** `IMPLEMENTED` in [`services/gateway/src/middleware/rate-limit.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/gateway/src/middleware/rate-limit.ts#L193).

---

### 6.2 Usage Events Stream

1. **Logical name:** Usage Events Stream
2. **Physical key template:** `usage-events` (configurable via `REDIS_USAGE_STREAM`).
3. **Purpose:** Distributed append-only log decoupling Gateway billable provider call emissions from Worker cost computation and database ingestion.
4. **Owner:** Gateway produces (`services/gateway/src/events/redis-publisher.ts`); Worker consumes (`services/worker/src/stream-consumer.ts`).
5. **Redis type:** `STREAM`.
6. **Stored-value format:** Stream entry with a single key-value field:
   - Field: `"payload"`
   - Value: Serialized JSON string matching `contracts/events/usage-event.v1.json` (UTF-8, maximum 262,144 bytes / 256 KiB).
7. **Identity dimensions:** Stream entry ID generated by Redis (`<timestampMs>-<sequenceNumber>`). The payload contains the unique domain identity `eventId` (UUID v4).
8. **Cluster hash tag:** None in current implementation.
9. **Time representation:** Redis default stream entry ID timestamp (epoch milliseconds) assigned by `*` in `XADD`. Inside payload: `occurredAt` is ISO 8601 UTC with trailing `Z`.
10. **Initialization rules:** Auto-created on first `XADD` or initialized by Worker on startup via `XGROUP CREATE usage-events kubefin-worker-v1 0 MKSTREAM`.
11. **Lifecycle and expiry:** Persistent append-only stream. No automated `MAXLEN` trimming or TTL is currently configured.
12. **Idempotency and uniqueness:** Message delivery is at-least-once. The consumer uses payload `eventId` as a unique database key (`_id` in MongoDB) to guarantee idempotent persistence.
13. **Failure behavior:** If publisher cannot reach Redis, it retries up to 3 times before returning `{ success: false, error }`. Messages larger than 256 KiB are rejected without publication.
14. **Evidence/status:** `IMPLEMENTED` in [`services/gateway/src/events/redis-publisher.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/gateway/src/events/redis-publisher.ts#L72) and [`services/worker/src/redis-stream-port.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/worker/src/redis-stream-port.ts#L34).

---

### 6.3 Usage Events Dead-Letter Stream

1. **Logical name:** Usage Events Dead-Letter Stream
2. **Physical key template:** `usage-events:dlq` (derived as `${REDIS_USAGE_STREAM}:dlq`).
3. **Purpose:** Quarantine stream holding unprocessable, invalid, or persistently failing event deliveries along with failure audit metadata.
4. **Owner:** Worker (`services/worker/src/redis-stream-port.ts`).
5. **Redis type:** `STREAM`.
6. **Stored-value format:** Stream entry containing structured audit fields:
   - `sourceStream`: String name of source stream (`"usage-events"`).
   - `sourceEntryId`: String ID of failed stream entry (e.g., `"1729630000000-0"`).
   - `failedAt`: ISO 8601 UTC timestamp string.
   - `failureCode`: Enum string: `INVALID_STREAM_ENVELOPE`, `INVALID_EVENT_SCHEMA`, or `PERSISTENCE_RETRIES_EXHAUSTED`.
   - `attempts`: String representation of delivery attempt count (e.g., `"5"`).
   - `payloadBytes`: String length of payload in bytes.
   - `payloadSha256`: Hexadecimal SHA-256 hash of raw payload.
   - `payload` (optional): Raw payload string. Only included for `PERSISTENCE_RETRIES_EXHAUSTED` within payload size limits. Omitted for validation errors.
7. **Identity dimensions:** Unique Redis stream entry ID. References `sourceStream` and `sourceEntryId`.
8. **Cluster hash tag:** None in current implementation.
9. **Time representation:** Stream entry ID timestamp (epoch ms) and `failedAt` ISO 8601 UTC timestamp.
10. **Initialization rules:** Created dynamically via `XADD` inside `deadLetterAndAckScript`.
11. **Lifecycle and expiry:** Persistent append-only stream. No automated trimming currently configured.
12. **Idempotency and uniqueness:** Guarded by checking `XPENDING` on the source stream inside Lua script; if the entry is not pending, DLQ publication is skipped.
13. **Failure behavior:** If DLQ publication fails, the source stream entry remains pending in the consumer group PEL for subsequent retry or manual operator intervention.
14. **Evidence/status:** `IMPLEMENTED` in [`services/worker/src/redis-stream-port.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/worker/src/redis-stream-port.ts#L4) and [`services/worker/src/stream-consumer.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/worker/src/stream-consumer.ts#L210).

---

### 6.4 Budget Limit

1. **Logical name:** Budget Limit
2. **Physical key template:** `budget:limit:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`
3. **Purpose:** Stores the maximum allowable spend for the budget scope in currency integer micro-units.
4. **Owner:** Control Plane (M2). Gateway reads during reservation.
5. **Redis type:** `STRING` (integer micro-units).
6. **Stored-value format:** Base-10 integer string matching regex `^[0-9]+$` representing micro-units ($1.00 = `1000000`). Maximum safe integer bound: `400_000_000_000_000` (400 trillion micro-units).
7. **Identity dimensions:** 5-tuple: `(tenantId, scopeType, scopeId, currency, period)`.
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** Applicable to the period defined in the key template (`daily` or `monthly`).
10. **Initialization rules:** Populated by Control Plane on budget creation or update from MongoDB collection `budgets`.
11. **Lifecycle and expiry:** Persistent key. Does not expire automatically. Updated or deleted when the budget limit is modified or deleted in the Control Plane.
12. **Idempotency and uniqueness:** Unique per 5-tuple budget identity.
13. **Failure behavior:** Per agreed policy:
    - Explicitly hard-enforced tenants (`enforcement == 'hard'`) missing required budget configuration reject requests with HTTP 402 `Payment Required` and error code `NO_BUDGET_FOR_CURRENCY` (per `contracts/api/gateway-api.yaml`).
    - Explicitly unbudgeted tenants and `alert_only` tenants are NOT rejected solely because a `budget:limit` key is absent.
    - Missing or invalid enforcement metadata fails safely with HTTP 503 `Service Unavailable` and error code `BUDGET_STORE_ERROR`.
    - Missing counters must never be treated as zero or unconstrained.
14. **Evidence/status:** `PROPOSED (Agreed Baseline in RFC v0.5.0; awaiting Task 3.2 unblocking)`.

---

### 6.5 Budget Spend Counter

1. **Logical name:** Budget Spend Counter
2. **Physical key template:** `budget:spend:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<window>`
3. **Purpose:** Tracks cumulative settled expenditure for a budget scope within a specific UTC calendar window.
4. **Owner:** Gateway (M1). Incremented during budget settlement.
5. **Redis type:** `STRING` (integer counter).
6. **Stored-value format:** Base-10 integer string matching regex `^[0-9]+$` in currency micro-units (e.g., `"1250000"` for $1.25).
7. **Identity dimensions:** 5-tuple plus `<window>` partition (`YYYY-MM-DD` or `YYYY-MM`).
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** UTC calendar window identifier. Authoritative time source is Gateway system clock verified in UTC.
10. **Initialization rules:** Lazily initialized to `0` by `reserve_budget.lua` on the first reservation in the window if it does not exist, or created during settlement.
11. **Lifecycle and expiry:** Key has a retention TTL that must span the entire active window duration plus a reconciliation grace period:
    - Daily windows: 48 hours + 24 hours grace = 72 hours (259,200 seconds).
    - Monthly windows: 35 days + 7 days grace = 42 days (3,628,800 seconds).
12. **Idempotency and uniqueness:** Incremented by `actual_spend_micros` via `INCRBY` in `settle_budget.lua` only on valid transition from `RESERVED_PRE_DISPATCH` or `DISPATCHED_IN_FLIGHT`.
13. **Failure behavior:** If missing during reservation, initialized safely to 0 only when accompanied by valid budget limit. If corrupted or malformed, Lua script aborts with error `CORRUPTED_SPEND_COUNTER` and fails closed.
14. **Evidence/status:** `PROPOSED` (defined in `contracts/redis/rfc-budget-enforcement.md`, Section 5.1).

---

### 6.6 Budget Reserved Counter

1. **Logical name:** Budget Reserved Counter
2. **Physical key template:** `budget:reserved:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`
3. **Purpose:** Tracks the total amount of currency micro-units currently reserved for active, in-flight, or uncertain provider calls.
4. **Owner:** Gateway (M1).
5. **Redis type:** `STRING` (integer counter).
6. **Stored-value format:** Base-10 integer string matching regex `^[0-9]+$` in currency micro-units.
7. **Identity dimensions:** 5-tuple: `(tenantId, scopeType, scopeId, currency, period)`.
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** Represents real-time reservation pool across concurrent in-flight requests.
10. **Initialization rules:** Lazily initialized to `0` on first reservation via `INCRBY`.
11. **Lifecycle and expiry:** **MUST NOT HAVE A TTL** while any non-terminal request record exists. Scripts must never call `EXPIRE` on this key.
12. **Idempotency and uniqueness:** Incremented by `reservation` in `reserve_budget.lua`; decremented by `reservation` in `settle_budget.lua`, `release_budget.lua`, or `reap_expired_reservations.lua`.
13. **Failure behavior:**
    - If decrement causes underflow (`current_reserved < amount`), scripts reject mutation with `UNDERFLOW_ON_REAP` / `INVARIANT_VIOLATION`. The counter must not be clamped or reset to zero.
    - If missing or corrupted, requests fail closed with `CORRUPTED_RESERVED_COUNTER`.
14. **Evidence/status:** `PROPOSED` (defined in `contracts/redis/rfc-budget-enforcement.md`, Section 5.1 & Protocol 6.1).

---

### 6.7 Budget Request Record

1. **Logical name:** Budget Request Record
2. **Physical key template:** `budget:req:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<eventId>`
3. **Purpose:** Stores the state, reserved amount, settled cost, and lifecycle timestamps for a single request reservation.
4. **Owner:** Gateway (M1).
5. **Redis type:** `HASH`.
6. **Stored-value format:** Redis Hash containing exact fields:
   - `amount`: String micro-units reserved (e.g., `"100000"`).
   - `state`: String lifecycle state enum: `RESERVED_PRE_DISPATCH`, `DISPATCHED_IN_FLIGHT`, `SETTLED`, `RELEASED_PRE_DISPATCH`, `RELEASED_UNBILLED`, `RELEASED_RECONCILED`, `EXPIRED_UNBILLED`, `UNCERTAIN_HELD`, or `ORPHANED_DISPATCHED_UNCERTAIN`.
   - `createdAt`: String unix epoch milliseconds.
   - `deadlineAt`: String unix epoch milliseconds.
   - `dispatchedAt` (optional): String unix epoch milliseconds.
   - `settledAt` (optional): String unix epoch milliseconds.
   - `settledCost` (optional): String micro-units actually spent.
   - `releasedAt` (optional): String unix epoch milliseconds.
   - `reapedAt` (optional): String unix epoch milliseconds.
   - `tenantId`, `scopeType`, `scopeId`, `currency`, `period`: Verifiable identity dimensions.
7. **Identity dimensions:** 5-tuple budget identity plus `<eventId>` (UUID v4).
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** Timestamps recorded as unix epoch milliseconds string representation (`Date.now()`).
10. **Initialization rules:** Written atomically by `reserve_budget.lua` in state `RESERVED_PRE_DISPATCH`.
11. **Lifecycle and expiry:**
    - Non-terminal states (`RESERVED_PRE_DISPATCH`, `DISPATCHED_IN_FLIGHT`, `UNCERTAIN_HELD`, `ORPHANED_DISPATCHED_UNCERTAIN`): **NO TTL**.
    - Terminal states (`SETTLED`, `RELEASED_*`, `EXPIRED_UNBILLED`): `EXPIRE` set to window retention TTL (48h daily / 35d monthly). *(Discrepancy Note: Pending M1/M3 pre-implementation decision on whether monthly terminal records should remain 35d window-only or be aligned to 42d to match `budget:spend` with the 7-day grace period).*
12. **Idempotency and uniqueness:** Uniquely keyed by `<eventId>`. Repeated reservation attempts with the same `<eventId>` return deterministic responses without duplicate increments.
13. **Failure behavior:** If hash is missing during settlement or dispatch, script returns `NO_ACTIVE_RESERVATION` or `CORRUPTED_REQUEST_RECORD`.
14. **Evidence/status:** `PROPOSED` (defined in `contracts/redis/rfc-budget-enforcement.md`, Section 5.1).

---

### 6.8 Reservation Expiry Index

1. **Logical name:** Reservation Expiry Index
2. **Physical key template:** `budget:res_expiry:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`
3. **Purpose:** Sorted set indexing active request reservations by deadline timestamp to allow the background reaper to scan expired requests efficiently without full keyspace scans.
4. **Owner:** Gateway (M1).
5. **Redis type:** `ZSET`.
6. **Stored-value format:**
   - Member: `<eventId>` (UUID v4 string).
   - Score: Expiration deadline as double-precision unix epoch milliseconds (`deadline_epoch`).
7. **Identity dimensions:** 5-tuple: `(tenantId, scopeType, scopeId, currency, period)`.
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** Score is epoch milliseconds. Authoritative Gateway clock.
10. **Initialization rules:** Initialized on first reservation via `ZADD` in `reserve_budget.lua`.
11. **Lifecycle and expiry:** Members added on reservation; score updated on dispatch; member removed via `ZREM` on settlement or clean release.
12. **Idempotency and uniqueness:** Member `<eventId>` is unique within the sorted set.
13. **Failure behavior:** If a member exists in `res_expiry` whose `budget:req` hash is missing or corrupted, the reaper **must not delete** the entry or silently release budget; it advances the score by 1 hour, logs `CORRUPTED_OR_MISSING_REQUEST_RECORD`, and raises an alert.
14. **Evidence/status:** `PROPOSED` (defined in `contracts/redis/rfc-budget-enforcement.md`, Section 5.1).

---

### 6.9 Budget Metadata

1. **Logical name:** Budget Metadata
2. **Physical key template:** `budget:meta:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`
3. **Purpose:** Stores operational policy flags and runtime attributes for the budget scope, including enforcement mode and unconstrained bypass entitlements.
4. **Owner:** Control Plane (M2). Gateway reads during reservation.
5. **Redis type:** `HASH`.
6. **Stored-value format:** Redis Hash containing specific string fields:
   - `enforcement`: Mode enum: `"hard"` (default) or `"alert_only"`.
   - `unconstrained`: String boolean: `"1"` (unconstrained bypass active) or `"0"` (enforce limit).
   - `alertThresholdPct`: Integer string representing percentage (e.g., `"80"`).
   - `updatedAt`: ISO 8601 UTC timestamp string.
7. **Identity dimensions:** 5-tuple: `(tenantId, scopeType, scopeId, currency, period)`.
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** ISO 8601 UTC for `updatedAt`.
10. **Initialization rules:** Populated by Control Plane on budget creation or modification.
11. **Lifecycle and expiry:** Persistent key without TTL. Deleted only when the budget is deleted.
12. **Idempotency and uniqueness:** Unique per budget scope.
13. **Failure behavior:** If `unconstrained` field is absent or malformed (anything other than `"1"` or `"0"`), Gateway defaults strictly to normal enforcement (`"0"`). Standalone bypass keys (such as `budget:unconstrained:<tenantId>`) are strictly forbidden.
14. **Evidence/status:** `PROPOSED` (defined in `contracts/redis/rfc-budget-enforcement.md`, Section 5.1 & Protocol 5.2).

---

### 6.10 Reconciliation Audit Record

1. **Logical name:** Reconciliation Audit Record
2. **Physical key template:** `budget:recon:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}:<window>`
3. **Purpose:** Records audit watermarks, run identifiers, and historical completion status of read-only drift detection and audited manual repair entries. Automated counter mutation is permanently disabled (Option C).
4. **Owner:** Reconciliation Worker / Operations (M3 / Shared).
5. **Redis type:** `STRING` (or `HASH`).
6. **Stored-value format:** Audit status marker string (e.g., `"COMPLETE"`, `"DRIFT_AUDITED"`) or JSON watermark object containing `{ runId, lastReconciledTimestamp, driftAmount, source }`.
7. **Identity dimensions:** 5-tuple budget identity plus `<window>`.
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** Unix epoch milliseconds or ISO 8601 UTC timestamp.
10. **Initialization rules:** Created by reconciliation audit job or manual repair runbook.
11. **Lifecycle and expiry:** Linked to window retention TTL.
12. **Idempotency and uniqueness:** Unique per budget window.
13. **Failure behavior:** If missing, window is treated as unaudited.
14. **Evidence/status:** `PROPOSED (Agreed Baseline in RFC v0.5.0 — Option C)`.

---

### 6.11 Reconciliation Distributed Lock

1. **Logical name:** Reconciliation Distributed Lock
2. **Physical key template:** `budget:recon:lock:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`
3. **Purpose:** Scope-wide distributed lock preventing concurrent execution of manual repair operations for the same budget scope. Requires a verified procedure to fence or drain Gateway writes before adjusting counters.
4. **Owner:** Reconciliation Worker / Operations (M3 / Shared).
5. **Redis type:** `STRING`.
6. **Stored-value format:** Unique operator/worker run identifier string (e.g., `<workerNodeId>-<uuid>`).
7. **Identity dimensions:** 5-tuple budget identity: `(tenantId, scopeType, scopeId, currency, period)`.
8. **Cluster hash tag:** `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}`.
9. **Time representation:** Acquired with a lease TTL (e.g., 30,000 ms) with heartbeat extension.
10. **Initialization rules:** Acquired via `SET NX PX 30000`.
11. **Lifecycle and expiry:** Explicitly released on job completion or auto-expired by lease TTL.
12. **Idempotency and uniqueness:** Mutually exclusive lock across the entire budget scope.
13. **Failure behavior:** If lock cannot be acquired, manual repair aborts immediately to avoid conflicting mutations.
14. **Evidence/status:** `PROPOSED (Agreed Baseline in RFC v0.5.0 — Option C)`.

---

## 7. Budget Counter Safety and Failure Behavior

> [!CAUTION]
> ### Mandatory Counter-Safety Invariants
> 1. **Missing Counters MUST NOT Be Treated as Zero:** A missing `budget:limit` key indicates an unconfigured or unverified budget scope. Under hard enforcement (`enforcement == 'hard'`), the Gateway **must fail closed** (HTTP 402 `Payment Required` / `NO_BUDGET_FOR_CURRENCY`). Explicitly unbudgeted and `alert_only` tenants are not rejected solely because a `budget:limit` key is absent. Missing or invalid enforcement metadata must fail safely (HTTP 503 `BUDGET_STORE_ERROR`). Authoritative counters must never be assumed to be zero or unconstrained.
> 2. **Missing Counters MUST NOT Be Reconstructed Automatically from Request Records:** Request records may be incomplete due to retention pruning, network partitions, or in-flight operations. Lua scripts and Gateway code must never guess or reconstruct missing aggregate counters on the fly.
> 3. **Malformed or Wrong-Type Counters MUST NOT Be Silently Reset:** If an existing counter key contains non-numeric data, an unexpected Redis type, or violates numerical bounds, scripts **must not** overwrite, clamp to zero, or repair with guessed values. They must abort immediately with explicit invariant error codes (`CORRUPTED_SPEND_COUNTER`, `CORRUPTED_RESERVED_COUNTER`).
> 4. **Fail-Closed Default:** Budget enforcement must fail safely whenever authoritative counter state is missing or invalid.
> 5. **No Implicit or Guessed Reconciliation:** Any recovery or reconciliation procedure requires an explicitly agreed, evidence-backed design signed off by both M1 and M3. No service is permitted to invent or execute automatic counter adjustments.
> 6. **Metadata Flags Alone Do Not Authorize Bypass:** An `unconstrained: "1"` flag in `budget:meta` is operational configuration, not proof of authorization. The Control Plane must verify caller administrative authorization before setting this flag. Gateway clients cannot request or trigger bypass via request headers or body parameters.

### Numerical Representation and Safety Bounds
- **Currency Unit:** Exact integer micro-units ($1.00 = `1,000,000` micro-units). Floating-point arithmetic in Redis strings or Lua scripts is strictly forbidden.
- **Maximum Numerical Bound:** All counters and reservation calculations are constrained to a maximum safe bound:
  `MAX_SAFE_MICROS = 400_000_000_000_000` (400 trillion micro-units = $400,000,000.00).
- **Overflow Protection:** Every Lua script validates that inputs and intermediate sums (`current_spend + current_reserved + reservation`) do not exceed `MAX_SAFE_MICROS`, protecting against Lua 5.1 / LuaJIT double-precision exact integer overflow (2^53 - 1 = `9,007,199,254,740,991`).

---

## 8. Initialization, Lifecycle, and Expiry Conventions

### Summary of Lifecycles by Key Category

```
Rate Limit Keys:
  INCR -> PEXPIRE (2 * windowMs) -> Eviction/Expiry

Stream Keys (usage-events, usage-events:dlq):
  XGROUP CREATE / XADD -> Persistent Append-Only (No automated trimming)

Budget Limit & Metadata Keys:
  Control Plane SET / HSET -> Persistent (No TTL) -> Explicit Delete on Budget Removal

Budget Spend Counters:
  Gateway Lazy Create (0) -> INCRBY on Settle -> Window TTL + Grace (72h daily / 42d monthly)

Budget Reserved Counters:
  Gateway INCRBY on Reserve -> DECRBY on Settle/Release -> NO TTL while active records exist

Budget Request Records:
  Non-terminal: NO TTL (Guarded against eviction)
  Terminal: EXPIRE set to remaining window retention TTL (48h daily / 35d monthly)

Reservation Expiry Index:
  ZADD on Reserve -> ZREM on Settle/Release -> Reaper Scans by Deadline
```

### Expiry and Retention Details
1. **Active Reservation Protection:** `budget:reserved` and non-terminal `budget:req` records never carry a TTL. Evicting an active reservation would cause under-counting of spend or duplicate dispatches.
2. **Review Deadline vs. Deletion TTL:** The 15-minute review deadline for ambiguous or timed-out dispatches (`UNCERTAIN_HELD`) is an operational inspection deadline scored in `budget:res_expiry`. It is **not** a deletion TTL. Active reservations remain held until resolved.
3. **Retention for Idempotency:** Settled and released request records are retained for the full window retention TTL (48h daily / 35d monthly) so late retries receive deterministic cached outcomes (`ALREADY_SETTLED`, `ALREADY_RELEASED`).

---

## 9. Stage 2 Streams and Dead-Letter Conventions

### Stream Topology
- **Primary Stream:** `usage-events` (configurable via `REDIS_USAGE_STREAM`).
- **Dead-Letter Stream:** `usage-events:dlq` (derived as `${REDIS_USAGE_STREAM}:dlq`).
- **Consumer Group:** `kubefin-worker-v1` (configurable via `REDIS_USAGE_GROUP`).

### Producer-Consumer Flow
1. **Producer (Gateway):** Calls `XADD usage-events * payload <json>` upon successful provider completion. Serialized payload size is capped at 256 KiB.
2. **Consumer (Worker):** Reads via `XREADGROUP` and `XAUTOCLAIM`. Validates JSON payload against `contracts/events/usage-event.v1.json`.
3. **Durable Persistence:** Worker persists valid events to MongoDB idempotently using `eventId` as `_id`.
4. **Acknowledgement:** Worker calls `XACK` only after durable MongoDB persistence completes.

### Dead-Letter Queue (DLQ) Rules
- **Atomic DLQ-and-Ack Script:** When an event delivery fails permanently (schema invalid, malformed envelope, or persistence retries exhausted), Worker executes `deadLetterAndAckScript`:
  - Verifies entry is still pending in PEL via `XPENDING`.
  - Publishes failure audit record to `usage-events:dlq` via `XADD`.
  - Acknowledges source entry from `usage-events` via `XACK`.
- **Payload Privacy Constraints:**
  - For validation errors (`INVALID_STREAM_ENVELOPE`, `INVALID_EVENT_SCHEMA`), the `payload` field **must be omitted** from the DLQ record to avoid persisting unvalidated or sensitive client input. `payloadBytes` and `payloadSha256` are recorded for auditing.
  - For retry exhaustion (`PERSISTENCE_RETRIES_EXHAUSTED`), the payload may be included only if `payloadBytes <= 262,144`.
- **Stream Retention and Trimming:** No automated trimming (`MAXLEN`) is configured in code. Adding retention policies or trimming requires prior team agreement.

---

## 10. Ownership Boundaries

| Component | Owned Redis Keys | Permitted Actions | Prohibited Actions |
| :--- | :--- | :--- | :--- |
| **Gateway (M1)** | `ratelimit:tenant:*`<br>`budget:spend:*`<br>`budget:reserved:*`<br>`budget:req:*`<br>`budget:res_expiry:*` | `INCR`, `PEXPIRE`<br>Publish to `usage-events`<br>Execute Stage 3 reservation/settlement Lua scripts | Modifying `budget:limit` or `budget:meta`<br>Writing directly to `usage-events:dlq`<br>Reconciling spend counters |
| **Control Plane (M2)** | `budget:limit:*`<br>`budget:meta:*` | Sync budget limits and metadata from MongoDB<br>Set/unset `unconstrained` bypass flag | Mutating spend or reservation counters<br>Modifying request records |
| **Worker (M3)** | `usage-events` (Consumer Group)<br>`usage-events:dlq` | `XGROUP CREATE`, `XREADGROUP`, `XAUTOCLAIM`<br>`XACK`<br>Execute `deadLetterAndAckScript` | Producing raw events to `usage-events`<br>Bypassing DLQ on permanent errors |
| **Reconciliation Worker (Future)** | `budget:recon:*`<br>`budget:recon:lock:*` | Read spend counters, audit drift vs MongoDB<br>Acquire/release recon lock | Blind overwrites of `budget:spend` (BLOCKED) |

---

## 11. Agreed Architectural Decisions & Remaining Pre-Implementation Gates

M1 (Gateway) and M3 (Worker / Control Plane) have reached explicit agreement on the core architectural decisions for Task 3.2:

### Agreed Architectural Decisions
1. **Missing-Budget & Enforcement Policy (Agreed):**
   - Hard-enforced tenants (`enforcement == 'hard'`) missing required budget configuration are rejected with HTTP 402 `Payment Required` and error code `NO_BUDGET_FOR_CURRENCY` (per `contracts/api/gateway-api.yaml`).
   - Explicitly unbudgeted tenants and `alert_only` tenants are admitted without rejection for missing limit keys.
   - Missing or invalid enforcement metadata fails safely with HTTP 503 `BUDGET_STORE_ERROR`.
2. **Reconciliation Architecture (Option C Agreed):**
   - Read-only drift detection and audited manual repair. Automated counter mutation and reconstruction are permanently rejected.
   - Manual repair requires acquiring the scope-wide distributed lock `budget:recon:lock:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` and executing a verified procedure to fence or drain Gateway writes before adjusting counters.
3. **Redis Cluster Stream Hash-Tagging (Agreed in Principle):**
   - Primary stream `{usage-events}` and DLQ stream `{usage-events}:dlq` will share hash tag `{usage-events}` to preserve atomic Lua DLQ-and-ACK execution in Redis Cluster.
   - Exact stream-key migration and rollback procedure must be documented and agreed before production deployment. In running code, stream keys remain `usage-events` until cutover.

### Pre-Implementation Readiness Gates (Task 3.2 Remains BLOCKED)
Task 3.2 remains strictly blocked until the following pre-implementation gates are satisfied:
1. **Stream Migration & Rollback Plan:** Formal procedure for deploying `{usage-events}` and draining legacy `usage-events` without orphaning in-flight messages.
2. **Manual Repair Operational Runbook:** Detailed runbook for acquiring the scope lock, fencing Gateway writes, auditing drift against MongoDB, and verifying counter adjustments.
3. **Window Initialization Protocol:** Owning mechanism to initialize new calendar windows and distinguish legitimately fresh windows from unexpectedly evicted mid-window counters (eliminating unsafe `GET or '0'`).
4. **Monthly Request Record Retention Alignment:** Decision on whether monthly terminal `budget:req` records expire at 35 days (window-only) or 42 days (matching `budget:spend` 35d window + 7d grace).
5. **Control Plane Sync Protocol:** Mechanism for synchronizing MongoDB `budgets` updates to Redis `budget:limit` and `budget:meta` (direct write vs change streams vs periodic refresh).
6. **Pre-Implementation Verification Tests:** Test suite verifying atomic reservation, fail-closed handling, and reaper recovery ready for execution.

---

## 12. Source References and Verification Checklist

### Authoritative Contract and Source References
- **Usage Event Schema:** [`contracts/events/usage-event.v1.json`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/contracts/events/usage-event.v1.json)
- **Budget Persistence Schema:** [`contracts/db/budgets.v2.json`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/contracts/db/budgets.v2.json)
- **Budget Enforcement RFC:** [`contracts/redis/rfc-budget-enforcement.md`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/contracts/redis/rfc-budget-enforcement.md)
- **Gateway Rate Limiter:** [`services/gateway/src/middleware/rate-limit.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/gateway/src/middleware/rate-limit.ts)
- **Gateway Event Publisher:** [`services/gateway/src/events/redis-publisher.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/gateway/src/events/redis-publisher.ts)
- **Worker Stream Port:** [`services/worker/src/redis-stream-port.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/worker/src/redis-stream-port.ts)
- **Worker Stream Consumer:** [`services/worker/src/stream-consumer.ts`](file:///home/vvedantrathod/MERN/WT%20Project/kubefin/services/worker/src/stream-consumer.ts)

### Implementation Verification Checklist
- [x] All 14 mandatory fields documented for every key definition.
- [x] Hash-tag convention `{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` strictly specified.
- [x] Scope identity rule documented: `scopeType = tenant` requires `scopeId = tenantId`.
- [x] Missing counter fail-closed safety rules prominently featured.
- [x] Stage 2 stream and DLQ payload privacy rules verified against worker implementation.
- [x] Ownership matrix clearly separates M1 Gateway, M2 Control Plane, and M3 Worker responsibilities.
- [x] Unsupported automated reconciliation mechanisms permanently rejected; Option C manual repair keys classified as PROPOSED.
