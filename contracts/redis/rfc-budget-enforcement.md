# RFC: Redis Budget Counter Contract & Real-Time Gateway Enforcement

- **Authors:** M1 (Vedant Rathod — AI Gateway) & M3 (Atharva — Worker / Asynchronous Pipeline)
- **Status:** Proposed / Under Review
- **Target Task:** Task 3.2 (Phase 3 Budget & Policy Enforcement)
- **Related Contracts:** `contracts/db/budgets.v2.json`, `contracts/api/control-plane-budgets.v2.yaml`, `contracts/db/usage-events.v1.json`, `contracts/redis/keys.md`

---

## 1. Context & Architectural Challenge

`contracts/db/budgets.v2.json` and `contracts/api/control-plane-budgets.v2.yaml` define currency-specific budget limits in MongoDB (`daily` or `monthly`, `hard` or `alert_only`).
However, Control Plane spend calculation relies on processed events in MongoDB `usage_events`, which **inherently lags Gateway traffic** as Worker consumes from Redis asynchronously.

To enforce hard budget caps and reject requests with HTTP 402 `Payment Required` *before* upstream LLM dispatch (preventing unbudgeted provider costs), the Gateway requires a synchronous, sub-millisecond spend counter in Redis.

---

## 2. Five Critical Contract Decisions Required from M3 (Atharva)

### Decision 1: Currency Handling & Multi-Currency Policy
* **Current State:**
  - AI Providers (Google Gemini, OpenAI, Anthropic) bill in **USD**.
  - Worker operates with `PRICING_CURRENCY=INR` (or USD). In `PRICING_CURRENCY=INR`, USD events remain `unpriced` to strictly prevent mixing currencies or hallucinating FX rates (`contracts/db/pricing-catalog.v1.json`).
  - `budgets.v2.json` enforces: `"currency": ISO 4217 code. No FX conversion is implied.`
* **Options:**
  - **Option 1A (Recommended): Currency-Isolated Budgets.** A tenant has distinct budgets per currency (e.g. a USD budget of `$50.00` and an INR budget of `₹10,000.00`). Gateway evaluates requests against the budget matching the model's pricing currency. If a tenant calls a USD model without a configured USD budget, it fails closed with HTTP 403/402 `NO_BUDGET_FOR_CURRENCY`.
  - **Option 1B: Token-Centric Budgets.** Budget limits in the Gateway are enforced purely in token allocation (e.g. 5,000,000 tokens/month), bypassing currency conversion entirely.
  - **Option 1C: Static Daily FX Snapshot.** Control Plane writes an authoritative daily FX conversion rate (e.g. `USD_TO_INR: 83.50`) to Redis; Gateway computes estimated INR cost deterministically.
* **M1 Recommendation:** **Option 1A** (or 1B). Option 1A preserves exact contract adherence without introducing currency volatility or cross-currency calculation bugs.

---

### Decision 2: Counter Updater & Synchronization Topology
* **Options:**
  - **Option 2A (Worker-Settled Counter):**
    - Worker increments Redis `budget:spend` upon computing exact `Decimal128` event cost in MongoDB.
    - Gateway only performs read-checks against `budget:spend` + `budget:limit`.
    - *Pros:* 100% exact cost; zero floating-point drift in Gateway.
    - *Cons:* Under high concurrency, Gateway can overrun the budget during the 50ms–5s Worker ingestion lag.
  - **Option 2B (Gateway Pre-Reservation + Worker Settlement - Recommended):**
    - Gateway atomically increments an *in-flight reservation* before calling the upstream provider based on `max_tokens` (or rolling average cost).
    - Upon receiving upstream response token counts, Gateway adjusts the spend counter.
    - Worker reconciles drift periodically.
  - **Option 2C (Gateway Authoritative Spend Counter):**
    - Gateway caches model rates from Redis (e.g. `$0.75/$3.75 per 1M tokens`) and atomically increments `budget:spend` immediately on upstream response completion.
* **M1 Recommendation:** **Option 2C** for real-time accuracy, backed by Option 2A background audit.

---

### Decision 3: Counter Precision & Data Representation in Redis
* **Current State:** MongoDB stores exact costs with up to 12 decimal places (`Decimal128`). Redis `INCRBYFLOAT` introduces IEEE-754 precision loss and floating-point drift over time.
* **Proposal:** Use **integer micro-units** ($1.000000 = `1,000,000` micro-units) or **sub-micro units / nano-units** ($1.00 = `1,000,000,000,000` units, 10^-12 precision).
* **Redis Command:** Atomic `INCRBY` on 64-bit signed integers (supports up to $9.22 × 10^12 in micro-units without overflow).

---

### Decision 4: Period Windowing & Expiration (TTL)
* **Keys:**
  - Daily: Indexed by UTC date `YYYY-MM-DD`. TTL: 48 hours (allows timezone grace and late auditing).
  - Monthly: Indexed by UTC month `YYYY-MM`. TTL: 35 days.
* Key rollover is automatic based on UTC calendar boundaries (`Math.floor(Date.now() / windowMs)` or UTC ISO string formatting).

---

### Decision 5: Failure Mode When Redis Is Degraded
* **Conventions in Gateway:** Rate limiter supports `fail-closed` vs `fail-open`.
* **Budget Policy:**
  - If `enforcement: "hard"`: default to `fail-closed` (HTTP 503 `BUDGET_STORE_ERROR` or HTTP 402) to guarantee zero unbudgeted enterprise spend.
  - If `enforcement: "alert_only"`: default to `fail-open` with `X-Budget-Degraded: true` header.
  - Configurable via `BUDGET_FAILURE_MODE=fail-closed|fail-open` in `services/gateway/.env`.

---

## 3. Proposed Redis Key Schema (To add to `contracts/redis/keys.md`)

| Key Pattern | Type | TTL | Description |
|---|---|---|---|
| `budget:limit:{tenantId}:{scopeType}:{scopeId}:{currency}:{period}` | `string` (int) | None (synced by CP) | Configured budget ceiling in integer micro-units (e.g. `100000000` for $100.00). |
| `budget:spend:{tenantId}:{scopeType}:{scopeId}:{currency}:{period}:{window}` | `string` (int) | Daily: 48h<br>Monthly: 35d | Cumulative spend in integer micro-units for UTC window (e.g. `2026-10-20` or `2026-10`). |
| `budget:meta:{tenantId}:{scopeType}:{scopeId}:{currency}:{period}` | `hash` | None | Metadata: `enforcement` (`hard`/`alert_only`), `alertThresholdPct` (`80`). |

*Scope Conventions:*
- Tenant scope: `scopeType=tenant`, `scopeId=default`
- Team scope: `scopeType=team`, `scopeId=<teamId>`
- Workload scope: `scopeType=workload`, `scopeId=<workloadId>`

---

## 4. Atomic Lua Enforcement Script (`check_budget.lua`)

```lua
-- KEYS[1]: budget:spend (e.g. budget:spend:acme:tenant:default:USD:monthly:2026-10)
-- KEYS[2]: budget:limit (e.g. budget:limit:acme:tenant:default:USD:monthly)
-- ARGV[1]: estimated_micro_cost (int)
-- ARGV[2]: ttl_seconds (int)

local limit = redis.call('GET', KEYS[2])
if not limit then
    -- No limit set for this currency/period: allow request
    return {1, 0, 0}
end

local limit_num = tonumber(limit)
local current_spend = tonumber(redis.call('GET', KEYS[1]) or '0')
local increment = tonumber(ARGV[1])

if (current_spend + increment) > limit_num then
    -- Budget exceeded: reject
    return {0, current_spend, limit_num}
end

-- Allowed: increment spend and ensure TTL on first write
local new_spend = redis.call('INCRBY', KEYS[1], increment)
if new_spend == increment then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end

return {1, new_spend, limit_num}
```

---

## 5. Edge Cases & Safety Invariants

| Edge Case | Gateway / Worker Behavior |
|---|---|
| **Upstream Request Fails (5xx / Timeout)** | If Gateway reserved estimated spend, an atomic rollback (`DECRBY`) is executed in `finally` block if upstream was not billed. |
| **Circuit Breaker Open** | Short-circuits with HTTP 503 *before* budget evaluation or reservation, preventing key churn. |
| **Ollama / Local Models (Zero Cost)** | Resolved model cost is 0; spend counter is bypassed or incremented by 0. |
| **Missing Token Metadata** | If provider returns no usage tokens, Gateway decrements reservation to zero and logs warning; Worker marks event `unpriced`. |
| **Month-End Boundary Rollover** | UTC timestamp dictates key name (`2026-10` vs `2026-11`). No race conditions; reset is immediate at 00:00:00 UTC without locking. |

---

## 6. Required Shared Contract Modifications

1. **`contracts/redis/keys.md`**: Append Section 3 (Budget Enforcement Keys & Lua script).
2. **`contracts/api/gateway-api.yaml`**: Add HTTP 402 `BUDGET_EXCEEDED` response schema to `/v1/chat/completions`.
3. **`contracts/api/control-plane-api.v2.yaml`**: **NO CHANGES** (preserves M3 ownership).
4. **`services/worker/*`**: **NO CHANGES** during Task 3.2 Gateway implementation.

---

## 7. Acceptance Criteria for Final Agreement

1. **Precision:** Spend tracked in integer micro-units without floating-point math.
2. **Currency Integrity:** Zero currency mixing; tenant budgets must explicitly match model rate currency.
3. **Fast-Fail:** Requests exceeding limit return HTTP 402 `BUDGET_EXCEEDED` with `Retry-After` / period reset metadata before calling the upstream LLM.
4. **Resilience:** Configurable `fail-closed` (HTTP 503 `BUDGET_STORE_ERROR`) vs `fail-open` on Redis connection failure.
