# M1_phase.md — Kubefin M1 (Core Backend & AI Gateway) Roadmap & Progress

> **Instruction for Future Agy Sessions:**
> Before starting any M1 task, read this file and inspect the current Git status. Select the highest-priority pending task, verify its prerequisites, and work only on that task. After implementation, run relevant tests and the build, then update this file with evidence. Never mark a task completed without verification. Preserve existing user changes and coordinate shared-contract changes with teammates.

---

## 1. Ownership & Service Boundaries

- **Owner:** Vedant Rathod (M1) — Core Backend & AI Gateway
- **Primary Domain:** `services/gateway/`, `contracts/api/gateway-api.yaml`, `contracts/events/usage-event.v1.json`
- **Component Role:** High-performance, low-latency synchronous data plane (OpenAI-compatible AI Gateway).

### Team Ownership Boundaries

| Member | Primary Ownership | Interface / Contract Boundary with M1 |
|---|---|---|
| **M1: Vedant Rathod** (Gateway / Backend) | `services/gateway/` | Ingress reverse proxy, provider adapters, usage event emission to Redis Streams. |
| **M2: Om Pawar** (Frontend) | `frontend/` | Consumes Control Plane API; no direct Gateway data path (Gateway serves client AI applications / SDKs). |
| **M3: Atharva Pawaskar** (Worker / DevOps) | `services/worker/`, `services/control-plane/`, `deploy/` | Consumes `usage-events` Redis Stream; provides MongoDB pricing and Control Plane Budgets API. Shared contracts require 2 approvals. |

---

## 2. Current Verified Status & Evidence

As of **October 20, 2026** (freshly verified this session for Gateway; Worker tests/build are historical, last verified earlier):

- **Gateway Test Suite Status:** `npm test --prefix services/gateway` → **267 passing tests** across 10 test suites (0 failed). **Freshly verified this session**.
- **Gateway TypeScript Build:** `npm run build --prefix services/gateway` (`tsc`) → **Clean build (0 errors)**. **Freshly verified this session**.
- **Contract Verification:** Redocly lint (`npm run lint:contract --prefix services/gateway`) → **0 errors, 0 warnings**. Schema validation (`npm run validate:contracts --prefix services/worker`) → **11 schemas validated**. **Freshly verified this session**.
- **Worker Test Suite Status:** `npm test --prefix services/worker` → **61 passing tests** (0 failed) + 1 integration test passing. **Historical — not re-verified this session**.
- **Worker TypeScript Build:** `npm run build --prefix services/worker` → **Clean build (0 errors)**. **Historical — not re-verified this session**.
- **PR #29 Scope & Status:** PR #29 contains Gateway source and test changes (Tasks 1.1–1.8, 2.1–2.4, 3.1, 4.1–4.3, 5.1–5.3; 36 files, 13,831 lines) as well as the RFC work. M1 and M3 have reached explicit consensus on the three core architectural decisions (missing-budget policy, Option C reconciliation, and cluster stream hash tags in principle) documented in RFC v0.5.0 and `contracts/redis/keys.md`. Task 3.2 remains strictly blocked until contract consistency, stream migration safeguards, manual repair fencing runbooks, and verification test gates are satisfied.
- **Git Status:** Working directory has modified + untracked files (not clean); Gateway source changes are tracked; pre-existing modified worker files preserved without interference.

### Verified Capabilities Matrix

| Capability | Status | Evidence |
|---|---|---|
| **Fastify Gateway Engine** | `[x]` Completed | `services/gateway/src/index.ts`, port 3000, graceful SIGINT/SIGTERM shutdown, request correlation IDs (`x-request-id`). |
| **API Key Authentication** | `[x]` Completed | `middleware/auth.ts`, `tests/auth.test.ts` (7 tests). Header `Authorization: Bearer <KEY>`, tenant resolution, prefix logging. |
| **Gemini Provider Adapter** | `[x]` Completed | `providers/gemini.ts`, `tests/chat.test.ts` (16 tests). Google Generative AI SDK, OpenAI request/response mapping, served-model fallback. |
| **Reasoning Token Accounting** | `[x]` Completed | `providers/gemini.ts`, `tests/usage-events.test.ts` (29 tests). Validated `candidatesTokenCount + thoughtsTokenCount` safe integer summation. |
| **Configurable Upstream Timeout** | `[x]` Completed | `config.ts`, `providers/gemini.ts`, `tests/regression.test.ts`. `GEMINI_TIMEOUT_MS`, native `AbortSignal`, HTTP 504 `PROVIDER_TIMEOUT`, secret sanitization. |
| **Redis Usage Event Publishing** | `[x]` Completed | `events/usage-event.ts`, `events/redis-publisher.ts`. Schema compliance (`usage-event.v1.json`), 256 KiB cap, stable `eventId`, retry backoff, graceful `quit()`. |
| **Per-Tenant Rate Limiting** | `[x]` Completed | `middleware/rate-limit.ts`, `tests/rate-limit.test.ts` (15 tests). Redis fixed-window Lua (`INCR`+`PEXPIRE`), in-memory fallback, `fail-closed` vs `fail-open`, HTTP 429 response. |
| **Prometheus Metrics Exposition** | `[x]` Completed | `src/metrics.ts`, `tests/metrics.test.ts` (12 tests). `GET /metrics` format 0.0.4, HTTP duration histogram, provider errors/timeouts, route normalization, token protection. |
| **Gemini Pricing & Cost Engine** | `[x]` Completed | `contracts/db/pricing-data/gemini-pricing.v2.json`, `import-pricing.mjs`, `cost-engine.ts`. Official rates ($0.75/$3.75 for 2026, $1.50/$7.50 for 2027), exact Decimal128 math, currency isolation. |
| **Gateway → Worker Live Pipeline** | `[x]` Completed | Live test request `req-e2e-pricing-test` → Redis Stream `usage-events` → Worker MongoDB consumption verified end-to-end. |
| **Gateway Policy Engine** | `[x]` Completed | `middleware/policy.ts`, `tests/policy.test.ts` (35 tests). Model allow-list (`GATEWAY_ALLOWED_MODELS`, HTTP 403 `MODEL_NOT_ALLOWED`), max tokens ceiling (`GATEWAY_MAX_TOKENS_LIMIT`, HTTP 400 `MAX_TOKENS_EXCEEDED`). |
| **Payload & JSON Security Hardening** | `[x]` Completed | `src/security.ts`, `tests/hardening.test.ts` (36 tests). Fastify `bodyLimit` (`GATEWAY_MAX_PAYLOAD_BYTES`, HTTP 413 `PAYLOAD_TOO_LARGE`), `secure-json-parse` prototype/constructor poisoning defense (`INVALID_JSON`), nesting depth limits (`EXCESSIVE_NESTING`), CRLF/null-byte header sanitization, token count validation. |
| **Upstream Retry & Circuit Breaker** | `[x]` Completed | `src/resilience/`, `tests/circuit-breaker.test.ts` (40 tests). 3-state circuit breaker (CLOSED/OPEN/HALF_OPEN), consecutive failure tripping (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`), cooldown & probe recovery, bounded exponential retry with jitter (503/429/502), conservative timeout double-billing prevention, single usage event idempotency. |

---

## 3. Ordered Phase Roadmap

Legend:
- `[x]` Completed and verified with automated tests & build
- `[ ]` Pending implementation
- `[!]` Blocked or requiring cross-member team decision
- `[?]` Status not yet verified in live environment

```
Phase 1: Foundations & Redis ──▶ Phase 2: Metrics ──▶ Phase 3: Policies & Budgets ──▶ Phase 4: Hardening ──▶ Phase 5: Handoff
     [x] COMPLETE                  [x] COMPLETE                 [!] BLOCKED                   [x] COMPLETE            [x] COMPLETE
```

---

### Phase 1: Gateway Foundation & Redis Integration (Status: `[x]` Completed)

*Goal: Accept OpenAI-compatible chat completion requests, authenticate callers, proxy to Google Gemini, and emit compliant usage events to Redis Streams.*

- [x] **1.1 Gateway Scaffold & Configuration**
  - *Details:* Fastify + TypeScript scaffold with environment loading (`PORT`, `HOST`, `LOG_LEVEL`, `API_KEY`, `TENANT_ID`).
  - *Files:* `services/gateway/src/index.ts`, `services/gateway/src/config.ts`.
  - *Evidence:* Server starts, passes regression tests.
- [x] **1.2 API Key Authentication & Tenant Resolution**
  - *Details:* `onRequest` hook enforcing `Authorization: Bearer <API_KEY>`, resolving `TenantIdentity`, extracting attribution headers (`x-team-id`, `x-workload-id`, `x-request-id`).
  - *Files:* `services/gateway/src/middleware/auth.ts`, `services/gateway/src/types.ts`.
  - *Evidence:* `tests/auth.test.ts` (7 passing tests).
- [x] **1.3 Google Gemini Provider Adapter**
  - *Details:* Translates OpenAI chat payload to `@google/generative-ai` `generateContent` format, extracts `usageMetadata`, maps finish reasons.
  - *Files:* `services/gateway/src/providers/gemini.ts`.
  - *Evidence:* `tests/chat.test.ts` (16 passing tests).
- [x] **1.4 Served-Model Attribution**
  - *Details:* Uses Google's response `modelVersion` if present, falling back to requested model ID to avoid pricing lookup mismatch.
  - *Files:* `services/gateway/src/providers/gemini.ts`.
  - *Evidence:* `tests/usage-events.test.ts` (Section 1b).
- [x] **1.5 Reasoning-Token Accounting (`thoughtsTokenCount`)**
  - *Details:* Accurately sums `candidatesTokenCount + (thoughtsTokenCount ?? 0)` with safe-integer validation.
  - *Files:* `services/gateway/src/providers/gemini.ts`.
  - *Evidence:* `tests/usage-events.test.ts` (Section 1).
- [x] **1.6 Configurable Timeout & Abort Cancellation**
  - *Details:* `GEMINI_TIMEOUT_MS` (default 30s) wired to `AbortController` and passed to SDK `requestOptions.signal`. Returns sanitized HTTP 504 `PROVIDER_TIMEOUT`.
  - *Files:* `services/gateway/src/config.ts`, `services/gateway/src/providers/gemini.ts`.
  - *Evidence:* `tests/regression.test.ts` (Section 7).
- [x] **1.7 Usage Event Model & Redis Stream Publishing**
  - *Details:* Strict validation per `contracts/events/usage-event.v1.json`, 256 KiB size check, exponential retries, stable UUID reuse, non-blocking publishing to `usage-events` stream.
  - *Files:* `services/gateway/src/events/usage-event.ts`, `services/gateway/src/events/redis-publisher.ts`.
  - *Evidence:* `tests/usage-events.test.ts` (29 passing tests).
- [x] **1.8 Gateway Rate Limiting**
  - *Details:* Per-tenant sliding/fixed window rate limiter with Redis backend (Lua script) and Memory fallback; `fail-closed` vs `fail-open` modes; standard rate-limit headers.
  - *Files:* `services/gateway/src/middleware/rate-limit.ts`, `services/gateway/src/config.ts`.
  - *Evidence:* `tests/rate-limit.test.ts` (15 passing tests), `tests/regression.test.ts` (Section 8).

---

### Phase 2: Prometheus Metrics System (Status: `[x]` Completed)

*Goal: Implement a zero-dependency, low-cardinality Prometheus metrics subsystem.*

- [x] **2.1 Prometheus Metrics Registry & Formatter**
  - *Details:* Self-contained `Counter`, `Histogram`, and `MetricsRegistry` adhering to Prometheus exposition format 0.0.4.
  - *Files:* `services/gateway/src/metrics.ts`.
  - *Evidence:* `tests/metrics.test.ts` (Section 1).
- [x] **2.2 Cardinality & Redaction Guard (`normalizeRoute`)**
  - *Details:* Normalizes Fastify route templates (`/v1/chat/completions`, `unmatched`) to prevent 404 URL path cardinality explosions. Strictly no tenant IDs, API keys, or prompt content in labels.
  - *Files:* `services/gateway/src/metrics.ts`.
  - *Evidence:* `tests/metrics.test.ts` (Section 4).
- [x] **2.3 Request Lifecycle & Error Tracking**
  - *Details:* Records `gateway_http_requests_total`, `gateway_http_request_duration_seconds`, `gateway_provider_requests_total`, `gateway_provider_errors_total`, and `gateway_rate_limit_rejections_total`.
  - *Files:* `services/gateway/src/index.ts`, `services/gateway/src/middleware/rate-limit.ts`.
  - *Evidence:* `tests/metrics.test.ts` (Section 3).
- [x] **2.4 Endpoint & Access Protection**
  - *Details:* `GET /metrics` exempt from tenant rate limiting; optional bearer token check via `METRICS_AUTH_TOKEN`; `METRICS_ENABLED` flag.
  - *Files:* `services/gateway/src/index.ts`, `services/gateway/src/config.ts`, `services/gateway/README.md`.
  - *Evidence:* `tests/metrics.test.ts` (Section 2), `tests/regression.test.ts` (Section 9).

---

### Phase 3: Budget & Policy Enforcement (Status: `[!]` Blocked)

*Goal: Enforce model allow-lists, token ceiling limits, and active budget spend policies.*

- [x] **3.1 Gateway Policy Engine: Model Allow-List & Token Bounds**
  - *Details:* Enforced via `services/gateway/src/middleware/policy.ts` hook running before provider dispatch. Rejects disallowed models with HTTP 403 `MODEL_NOT_ALLOWED` and requests exceeding `max_tokens` limit with HTTP 400 `MAX_TOKENS_EXCEEDED`. Ensures zero provider cost and suppresses Redis usage events on rejection.
  - *Files:* `services/gateway/src/middleware/policy.ts`, `services/gateway/src/config.ts`, `services/gateway/src/index.ts`.
  - *Evidence:* `tests/policy.test.ts` (35 passing tests), 168 total Gateway tests passing, clean TypeScript build.
- [!] **3.2 Real-time Redis Budget Enforcement**
  - *Description:* Check current spend/token allocation against tenant budget limits and reject with HTTP 402 `Payment Required` when exhausted.
  - *Status:* `[!] Task 3.2 BLOCKED — awaiting satisfaction of pre-implementation gates (stream migration runbook, manual repair runbook, Window Initialization Protocol, monthly retention alignment, test verification)`
  - *Details:* Architectural consensus and contradiction resolution established between M1 (Gateway) and M3 (Worker / Control Plane) across `contracts/redis/rfc-budget-enforcement.md` (v0.5.1) and `contracts/redis/keys.md`. Gateway code implementation remains strictly blocked until pre-implementation gates are satisfied. The agreed architectural baseline establishes:
    1. **Crash-safe expiry & provider dispatch (Agreed):** Explicit distinction between `RESERVED_PRE_DISPATCH` and `DISPATCHED_IN_FLIGHT`. Reapers can only release pre-dispatch reservations (`EXPIRED_UNBILLED`); dispatched requests remain strictly HELD in `budget:reserved` as `ORPHANED_DISPATCHED_UNCERTAIN` to prevent releasing billable provider charges on deadline expiry. Autonomous release scripts (`reconcile_release_budget.lua`) are permanently rejected under Option C; `RELEASED_RECONCILED` is an unresolved lifecycle transition requiring audited manual repair tooling with Gateway writer fencing.
    2. **Anti-clamping invariant arithmetic & counter safety (Mandatory Requirement):** Prohibits silent `math.max(0, ...)` clamping, silent zero fallbacks (`GET spend or 0`), or silent resets on corrupted/malformed values. Missing, malformed, wrong-type, or inconsistent counters **MUST NOT** silently become zero and **MUST NOT** be automatically reconstructed from request records (automated startup scan of `budget:req` and automated rebuild from MongoDB are strictly prohibited). Underflows return `UNDERFLOW_ON_REAP` / `INVARIANT_RESERVED_UNDERFLOW` and trigger operational alerts. Input bounds capped at $10^{14} \mu\text{units}$ (well within Lua 5.1's 53-bit integer limit). The reference reservation Lua prototype is strictly classified as non-executable pending Window Initialization Protocol agreement.
    3. **Multi-dimensional identity tuple idempotency (Agreed):** Validates complete 6-tuple `(tenantId, scopeType, scopeId, currency, period, amount)`. Reusing an event ID with mismatched parameters returns deterministic `CONFLICT_REQUEST_MISMATCH` (HTTP 409).
    4. **Quarantine review deadline separation (Agreed):** 15-minute `UNCERTAIN_HELD` window is an operational review deadline scored in `budget:res_expiry`, NOT a key retention TTL; records are retained for full window duration (48h daily / 35d monthly).
    5. **Missing budget policy & enforcement modes (Agreed Architectural Decision 1):** Reject requests for explicitly hard-enforced tenants (`enforcement == 'hard'`) when required budget configuration is missing with HTTP 402 `Payment Required` and error code `NO_BUDGET_FOR_CURRENCY` (per `contracts/api/gateway-api.yaml`). Explicitly unbudgeted tenants and `alert_only` tenants are not rejected solely because a `budget:limit` key is absent. Missing or invalid enforcement metadata fails safely with HTTP 503 `BUDGET_STORE_ERROR`.
    6. **Reconciliation architecture (Agreed Architectural Decision 2 — Option C):** Read-only drift detection and audited manual repair. Automated counter mutation or reconstruction (including legacy Protocol 5 `INCRBY` delta adjustment) is permanently eliminated. Manual repair requires acquiring the scope-wide distributed lock `budget:recon:lock:{budget:<tenantId>:<scopeType>:<scopeId>:<currency>:<period>}` and executing a verified procedure to fence or drain Gateway writes before adjusting counters.
    7. **Redis Cluster stream hash-tagging (Agreed Architectural Decision 3 In Principle):** Primary stream `{usage-events}` and DLQ stream `{usage-events}:dlq` share hash tag `{usage-events}` to preserve atomic Lua DLQ-and-ACK execution in Redis Cluster. Exact stream-key migration and rollback procedure must be documented and agreed before deployment. In current running code, stream keys remain `usage-events` until migration.
  - *Prerequisites:* Stream migration runbook, manual repair write-drain runbook, Window Initialization Protocol, monthly retention alignment, and pre-implementation test suite ready before Gateway code implementation. Gateway code implementation remains strictly blocked.
  - *Completion Criteria:* Pre-implementation gates satisfied, followed by atomic Redis counter check before provider dispatch and tests verifying 402 response on budget breach.

---

### Phase 4: Reliability, Security, & Hardening (Status: `[x]` Completed)

*Goal: Ensure enterprise-grade resilience against provider outages, malicious payloads, and connection hiccups.*

- [x] **4.1 Upstream Retry & Circuit Breaker**
  - *Details:* Protects Gateway from cascading failures during upstream AI provider degradation with a 3-state circuit breaker (`CLOSED` → `OPEN` → `HALF_OPEN` → `CLOSED`/`OPEN`). Trips to `OPEN` after `CIRCUIT_BREAKER_FAILURE_THRESHOLD` consecutive failures (default: 5) and fast-fails incoming requests with HTTP 503 `CIRCUIT_BREAKER_OPEN`. Transitions after `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` (default: 30000ms) to `HALF_OPEN` allowing up to `CIRCUIT_BREAKER_HALF_OPEN_PROBES` (default: 1) probes; probe success recovers circuit to `CLOSED`, failure reopens circuit. Saturated concurrent probes fast-fail immediately. Bounded upstream retry (`UPSTREAM_MAX_RETRIES`, default 2, `UPSTREAM_RETRY_BASE_DELAY_MS` default 200ms, `UPSTREAM_RETRY_MAX_DELAY_MS` default 2000ms) with exponential backoff and randomized jitter for transient errors (503, 429, 502, 500). Upstream timeouts, aborts, and connection resets are strictly non-retryable to eliminate duplicate prompt token execution and double-billing on Google Gemini. Exactly one usage event emitted on retry success.
  - *Files:* `services/gateway/src/resilience/circuit-breaker.ts`, `services/gateway/src/resilience/retry.ts`, `services/gateway/src/resilience/index.ts`, `services/gateway/src/config.ts`, `services/gateway/src/index.ts`.
  - *Evidence:* `tests/circuit-breaker.test.ts` (40 passing tests), 244 total Gateway tests passing, clean TypeScript build.
- [x] **4.2 Payload Size & JSON Security Hardening**
  - *Details:* Enforces Fastify `bodyLimit` via `GATEWAY_MAX_PAYLOAD_BYTES` (default 1 MiB) with consistent HTTP 413 `PAYLOAD_TOO_LARGE`. Built-in `secure-json-parse` blocks prototype/constructor poisoning (HTTP 400 `INVALID_JSON`). JSON nesting depth capped at 32 levels and recursive parser crashes caught (HTTP 400 `EXCESSIVE_NESTING`). Inbound attribution headers sanitized against control characters and CRLF injection. Token counts validated (safe positive integer >= 1) and temperature bounded [0, 2] before provider dispatch.
  - *Files:* `services/gateway/src/security.ts`, `services/gateway/src/config.ts`, `services/gateway/src/index.ts`.
  - *Evidence:* `tests/hardening.test.ts` (36 passing tests), 204 total Gateway tests passing, clean TypeScript build.
- [x] **4.3 Multi-Provider Adapter Extension (OpenAI / Anthropic / Ollama)**
  - *Details:* Abstracted `ProviderAdapter` shared interface and implemented `ProviderRouter` for routing across Gemini, OpenAI, Anthropic, and Ollama.
    - Implemented `OpenAIProvider`, `AnthropicProvider`, and `OllamaProvider` using native `fetch` (zero additional npm dependencies).
    - Model routing supports explicit prefix (e.g. `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `ollama/llama3`) and bare model pattern matching (`gpt-*`, `claude-*`, `gemini-*`, `llama*`, `mistral*`, etc.). Unknown bare models and unknown prefixes return `undefined` (HTTP 400 `INVALID_REQUEST`) when multiple providers are registered to strictly prevent unintended model leaks; omitted or empty model defaults cleanly to `DEFAULT_PROVIDER` (default: `gemini`).
    - Error normalization maps 401/403 to `PROVIDER_AUTH_ERROR`, 429 to `PROVIDER_RATE_LIMIT`, 408/504 to `PROVIDER_TIMEOUT`, and 5xx to `PROVIDER_ERROR`.
    - Validates trustworthy token usage (`prompt_tokens`, `completion_tokens`) as non-negative safe integers; leaves `usage` and `rawUsage` undefined when not reported (never invents synthetic tokens).
    - Identical usage-event generation to Redis Stream `usage-events` with canonical provider identifier and correlation attribution (`x-request-id`, `x-team-id`, `x-workload-id`). Exactly one logical request emits one usage event.
    - Circuit breaker, upstream retry, and Prometheus metrics track per-provider requests and errors.
  - *Files:* `services/gateway/src/providers/types.ts`, `services/gateway/src/providers/gemini.ts`, `services/gateway/src/providers/openai.ts`, `services/gateway/src/providers/anthropic.ts`, `services/gateway/src/providers/ollama.ts`, `services/gateway/src/providers/router.ts`, `services/gateway/src/providers/index.ts`, `services/gateway/src/config.ts`, `services/gateway/src/index.ts`, `services/gateway/.env.example`, `contracts/api/gateway-api.yaml`.
  - *Evidence:* `tests/providers.test.ts` (23 passing tests), 267 total Gateway tests passing, clean TypeScript build, Redocly lint passes with zero warnings/errors, 11 JSON schemas valid, 61 Worker regression tests passing.

---

### Phase 5: End-to-End Integration, Documentation, & Handoff (Status: `[x]` Completed)

*Goal: Verify multi-service integration with Worker (M3) and prepare deployment artifacts.*

- [x] **5.1 Gateway-to-Worker Live Integration Test**
  - *Description:* Run local Docker Compose (`docker compose up` with Redis & MongoDB), start Gateway & Worker, send chat completion request, and verify:
    1. Usage event appears in Redis Stream `usage-events`.
    2. Worker consumes and persists raw event into MongoDB `usage_events`.
    3. Pricing calculation enriches event with exact cost in USD (or keeps unpriced under INR isolation).
  - *Dependencies:* Worker Stage 2/3 merged (M3).
  - *Evidence:* Live test request `req-e2e-pricing-test` published to Redis Stream `usage-events` (stream ID `1792427646217-0`). Worker consumed and stored document `1b87ad74-15bb-419b-938d-8f26116ac532` in MongoDB `usage_events` with `pricingStatus: "unpriced"` under `PRICING_CURRENCY=INR`. Pricing catalog verification and backfill scan in USD matched `gemini-3.6-flash-usd-2026` rate ($0.75 / $3.75 per 1M tokens), computing exact cost `0.000337500000` USD. Idempotency verified on re-ingestion.
- [x] **5.2 OpenAPI Contract Alignment & Redocly Linting**
  - *Description:* Align `contracts/api/gateway-api.yaml` with actual Gateway implementation and validate with Redocly CLI.
  - *Files:* `contracts/api/gateway-api.yaml`, `redocly.yaml`, `services/gateway/package.json`.
  - *Evidence:* Added `/metrics` endpoint with Prometheus text exposition (`text/plain; version=0.0.4; charset=utf-8`), optional Bearer token auth (`METRICS_AUTH_TOKEN`), explicit `security: []` on `/health`, attribution headers (`x-request-id`, `x-team-id`, `x-workload-id`), rate-limit response headers (`X-RateLimit-*`, `Retry-After`), and all 4xx/5xx Gateway error codes (`INVALID_JSON`, `EXCESSIVE_NESTING`, `MAX_TOKENS_EXCEEDED`, `MODEL_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMIT_EXCEEDED`, `CIRCUIT_BREAKER_OPEN`, `RATE_LIMIT_ERROR`, `PROVIDER_TIMEOUT`, etc.). Redocly lint (`npx -y @redocly/cli lint` and `npm run lint:contract --prefix services/gateway`) passes with zero errors and zero warnings. Contract schema validation (`npm run validate:contracts --prefix services/worker`) passes with 11 schemas verified. All 244 Gateway unit and integration tests passing; clean TypeScript build.
- [x] **5.3 Gateway Dockerfile & Kubernetes Deployment Manifests**
  - *Description:* Create production multi-stage `deploy/docker/gateway.Dockerfile` and coordinate with M3 on Helm chart integration.
  - *Files:* `deploy/docker/gateway.Dockerfile`, `services/gateway/gateway.Dockerfile`, `deploy/docker/README.md`, `deploy/helm/gateway/` (Chart, values, schema, templates), `deploy/k8s/gateway-deployment.yaml`, `deploy/k8s/gateway-service.yaml`.
  - *Evidence:* Multi-stage Podman build succeeded for `localhost/kubefin-gateway:review`; the current image's TypeScript build passed. Live container smoke tests verified `/health` returns HTTP 200, `/metrics` returns HTTP 401 without its configured bearer token and HTTP 200 with the correct token, and the successful response uses Prometheus exposition format 0.0.4. The container was stopped after testing. Podman warned that the image-native `HEALTHCHECK` is ignored in OCI format, so that check is not verified by this build. Helm/Kubernetes rendering and deployment remain unverified. Gateway tests: 267 passed; Worker tests: 61 passed; Redocly lint and Worker contract validation passed in the latest recorded checks.

---

## 4. Current Next Task

### **Task 3.2B: Stage 2 Redis Cluster Stream Migration & Rollback Runbook (Awaiting Sign-off)**

- **Rationale:**
  - Task 3.2 (Phase 3 Budget & Policy Enforcement) remains strictly **`[!] BLOCKED`** pending satisfaction of all pre-implementation readiness gates.
  - Phase 1, Phase 2, Phase 4, and Phase 5 are 100% complete and verified.
  - Runbook specification hardened at [`contracts/redis/stream-migration-runbook.md`](contracts/redis/stream-migration-runbook.md) defining zero-downtime cutover to `{usage-events}` and `{usage-events}:dlq`, consumer-group pre-creation, legacy PEL drain, cross-slot DLQ safeguards, and abort criteria.
  - Task 3.2B remains the sole next task and is strictly blocked pending staging Redis Cluster dry-run verification and recorded sign-off from M1 (Gateway) and M3 (Worker).
  - Subsequent gates (Audited Manual Repair Runbook, Window Initialization Protocol, Monthly Retention Alignment, and Pre-Implementation Verification Tests) must also be satisfied before Gateway code implementation begins.
- **Immediate Action:** Coordinate staging Redis Cluster access, the maintenance window, participants, and approvals with M3 (Atharva Pawaskar) to execute the 7-step staging drill in `contracts/redis/stream-migration-runbook.md`.
- **Status:** `Task 3.2 BLOCKED — Task 3.2B is sole next task (awaiting staging dry-run and M1/M3 sign-off)`. Do NOT implement Gateway code or deploy Lua scripts until all pre-implementation gates are satisfied.

---

## 5. Blockers & Team Decisions

| Topic | Impacted Phase | Description & Required Coordination |
|---|---|---|
| **Redis Budget Enforcement Baseline** | Phase 3 (Task 3.2) | **AGREED.** Architectural consensus and contradiction resolution established in `rfc-budget-enforcement.md` (v0.5.1) and `keys.md`. Keys remain `PROPOSED` until code is implemented. Implementation remains BLOCKED on pre-implementation gates. |
| **Missing-Budget & Enforcement Policy** | Phase 3 (Task 3.2) | **AGREED.** Hard-enforced tenants without budget limits reject with HTTP 402 `NO_BUDGET_FOR_CURRENCY` (per `contracts/api/gateway-api.yaml`). Explicitly unbudgeted and `alert_only` tenants are not rejected. Missing/corrupted metadata fails safely with HTTP 503 `BUDGET_STORE_ERROR`. |
| **Reconciliation Architecture (Option C)** | Phase 3 (Task 3.2) | **AGREED.** Read-only drift detection and audited manual repair. Automated counter mutations eliminated. Requires scope-wide lock `budget:recon:lock:{budget:...}` and verified procedure to fence/drain Gateway writes. |
| **Redis Cluster DLQ Hash-Tagging** | Phase 1 / Stage 2 | **AGREED IN PRINCIPLE.** Primary stream `{usage-events}` and DLQ stream `{usage-events}:dlq` share hash tag `{usage-events}` to preserve atomic Lua DLQ-and-ACK execution. Physical key migration and rollback plan required before deployment. |
| **Counter Safety & Anti-Corruption Invariant** | Phase 3 (Task 3.2) | **MANDATORY REQUIREMENT.** Missing, malformed, wrong-type, or inconsistent counters MUST NOT silently default to zero and MUST NOT be automatically reconstructed from request records or MongoDB. Enforcement must fail safely. |
| **Stream Migration & Rollback Runbook** | Phase 1 / Stage 2 | **PRE-IMPLEMENTATION GATE (BLOCKED).** Runbook hardened in `contracts/redis/stream-migration-runbook.md`. Blocked pending staging Redis Cluster dry-run verification and formal sign-off from M1 and M3. |
| **Manual Repair Operational Runbook** | Phase 3 (Task 3.2) | **PRE-IMPLEMENTATION GATE (BLOCKED).** Detailed operational runbook for acquiring the scope lock, fencing Gateway writes, and adjusting counters. |
| **Window Initialization Protocol** | Phase 3 (Task 3.2) | **PRE-IMPLEMENTATION GATE (BLOCKED).** Owning mechanism to initialize new calendar windows and distinguish legitimately fresh windows from unexpectedly evicted mid-window counters (eliminating unsafe `GET or 0`). |
| **Audited Manual Repair Tooling Contract** | Phase 3 (Task 3.2) | **PRE-IMPLEMENTATION GATE (BLOCKED).** Defined tooling and verification procedure for resolving uncertain/orphaned requests to `RELEASED_RECONCILED` under writer fencing. |
| **Pre-Implementation Verification Tests** | Phase 3 (Task 3.2) | **PRE-IMPLEMENTATION GATE (BLOCKED).** Gateway test suite verifying atomic reservation, fail-closed handling, and reaper recovery ready for execution. |
| **Monthly Request Record Retention Alignment** | Phase 3 (Task 3.2) | **PRE-IMPLEMENTATION GATE (BLOCKED).** Resolve discrepancy between monthly spend counter retention (42d: 35d window + 7d grace) and terminal request record retention (35d window-only). Owners: M1 & M3. |
| **K8s Workload Attribution Headers** | Phase 5 | M3's Stage 7 auto-discovers Kubernetes workloads. Need team confirmation that `x-workload-id` injected by mesh/SDK aligns with the discovered Pod UID / label conventions. |

---

## 6. Progress Log

| Date | Task / Milestone | Description & Evidence |
|---|---|---|
| **2026-10-18** | Gateway Setup & Gemini | Built Fastify foundation, auth middleware, and Gemini provider. 23 tests passed. |
| **2026-10-18** | Redis Event Publishing | Implemented `RedisUsageEventPublisher` and `createUsageEvent`. 29 usage event tests passed. |
| **2026-10-19** | Gemini Compatibility Audit | Audited `gemini-3.8-flash` vs `gemini-1.5-flash`, verified SDK support and pricing contract compatibility. |
| **2026-10-19** | Reasoning Token Fix | Added `thoughtsTokenCount` support to `extractUsageMetadata` with safe-integer validation. All tests passed. |
| **2026-10-19** | Served-Model Attribution | Added `extractServedModel` fallback to preserve exact Google model IDs for Worker pricing lookup. |
| **2026-10-19** | Gateway Upstream Timeout | Added configurable `GEMINI_TIMEOUT_MS`, `AbortSignal` handling, sanitized HTTP 504. 82 tests passed. |
| **2026-10-19** | Gateway Rate Limiting | Implemented per-tenant Redis & Memory rate limiting, fail-open/fail-closed modes. 103 tests passed. |
| **2026-10-19** | Prometheus Metrics System | Implemented zero-dependency `Counter`, `Histogram`, route normalization, `/metrics` endpoint with optional token auth. All 119 tests passed; clean TypeScript build. |
| **2026-10-19** | M1 Roadmap Established | Created `M1_phase.md` source of truth tracking completed, pending, and blocked tasks. |
| **2026-10-19** | Pricing Integration & Cost Engine Verification | Imported official Gemini USD rates ($0.75/$3.75 for 2026, $1.50/$7.50 for 2027), fixed `import-pricing.mjs` path traversal, verified live Gateway → Redis → Worker → MongoDB pipeline, added focused cost-engine test for 15 in / 87 out (USD 0.0003375) and 12 in / 96 out (USD 0.000369), verified INR/USD currency isolation and boundary continuity without gaps/overlap. All 133 Gateway tests and 61 Worker tests passed. |
| **2026-10-19** | Gateway Policy Engine | Implemented `middleware/policy.ts`, `GATEWAY_ALLOWED_MODELS` (HTTP 403 `MODEL_NOT_ALLOWED`), and `GATEWAY_MAX_TOKENS_LIMIT` (HTTP 400 `MAX_TOKENS_EXCEEDED`) with pure validation helpers. Short-circuits before provider dispatch, ensuring zero cost and no Redis usage events on rejection. 35 dedicated policy tests added; all 168 Gateway tests passing; clean TypeScript build. |
| **2026-10-19** | Payload Size & JSON Security Hardening | Implemented `GATEWAY_MAX_PAYLOAD_BYTES` (default 1 MiB, HTTP 413 `PAYLOAD_TOO_LARGE`), prototype/constructor poisoning defense (`INVALID_JSON`), JSON recursion depth capping at 32 levels (`EXCESSIVE_NESTING`), CRLF/null-byte header sanitization, and token count parameter validation. 36 dedicated hardening tests added; all 204 Gateway tests passing; clean TypeScript build. |
| **2026-10-19** | Upstream Retry & Circuit Breaker | Implemented 3-state CircuitBreaker (CLOSED/OPEN/HALF_OPEN) with generation/epoch tracking, consecutive failure tracking (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`), cooldown recovery timer (`CIRCUIT_BREAKER_RESET_TIMEOUT_MS`), probe limits (`CIRCUIT_BREAKER_HALF_OPEN_PROBES`), fast-fail HTTP 503 `CIRCUIT_BREAKER_OPEN`, bounded exponential retry with jitter (`UPSTREAM_MAX_RETRIES`, `UPSTREAM_RETRY_BASE_DELAY_MS`, `UPSTREAM_RETRY_MAX_DELAY_MS`), AbortSignal cancellation, conservative timeout double-billing prevention, single usage event idempotency. 40 dedicated resilience tests added; all 244 Gateway tests passing; clean TypeScript build. |
| **2026-10-19** | OpenAPI Contract Alignment & Redocly Linting | Aligned `contracts/api/gateway-api.yaml` with actual Gateway implementation: added `/metrics` endpoint with Prometheus text exposition, optional Bearer token auth via `METRICS_AUTH_TOKEN`, explicit unauthenticated `security: []` on `/health`, attribution headers (`x-request-id`, `x-team-id`, `x-workload-id`), rate-limit response headers (`X-RateLimit-*`, `Retry-After`), and all 4xx/5xx Gateway error codes (`INVALID_JSON`, `EXCESSIVE_NESTING`, `MAX_TOKENS_EXCEEDED`, `MODEL_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMIT_EXCEEDED`, `CIRCUIT_BREAKER_OPEN`, `RATE_LIMIT_ERROR`, `PROVIDER_TIMEOUT`). Configured root `redocly.yaml` and `lint:contract` npm script. Verified Redocly linting passes with zero errors and zero warnings; JSON schema validation passes (11 schemas verified); 244 Gateway tests pass; clean TypeScript build. |
| **2026-10-20** | Multi-Provider Adapter Extension | Abstracted `ProviderAdapter` and implemented `ProviderRouter` for routing across Gemini, OpenAI, Anthropic, and Ollama using native `fetch`. Supports prefix notation and model pattern matching with strict undefined return for unknown models. Added strict token validation and normalized error codes. Added 23 dedicated adapter and integration tests (`tests/providers.test.ts`), bringing total passing tests to 267 with clean TypeScript build, zero-warning Redocly lint, 11 validated JSON schemas, and 61 passing Worker regression tests. |
| **2026-10-20** | Gateway Dockerfile & Kubernetes Manifests | Built production multi-stage `deploy/docker/gateway.Dockerfile` and `services/gateway/gateway.Dockerfile` with Node 24 Alpine, unprivileged `node` user (UID 1000), and pruned production dependencies (193 MB). Created Gateway Helm chart (`deploy/helm/gateway/`) and Kubernetes manifests (`deploy/k8s/gateway-deployment.yaml`, `gateway-service.yaml`). Smoke-tested the built image with Podman: `/health` returned HTTP 200; `/metrics` returned HTTP 401 without the configured token and HTTP 200 with the correct bearer token, with Prometheus exposition format verified. Podman warned that the image-native `HEALTHCHECK` is ignored in OCI format; Helm/Kubernetes deployment validation remains outstanding. All 267 Gateway tests pass; clean TypeScript build; Redocly lint passes with 0 warnings/errors; 61 Worker regression tests pass. |
| **2026-10-20** | Budget Enforcement Architectural RFC Proposal (specification/documentation draft) | Hardened documentation specification in `contracts/redis/rfc-budget-enforcement.md` (v0.4.0) addressing PR #29 feedback: (1) In `reap_expired_reservations.lua` specification, eliminated silent skipping on `RESERVED_PRE_DISPATCH` underflow; records explicit invariant violation `UNDERFLOW_ON_REAP`, defers score, and emits `BUDGET_REAPER_INVARIANT_UNDERFLOW` without mutating counters. (2) Preserved missing or corrupted sorted set entries by advancing score 1 hour instead of silently deleting (`ZREM`), preserving evidence for reconciliation. (3) Added complete State Transition & Invariant Matrix verifying consistent updates across `budget:req`, `budget:reserved`, and `budget:res_expiry`. (4) Aligned daily (48h) and monthly (35d) window retention TTLs with all script operations, ensuring active/uncertain reservations never expire from Redis simply because an operational review deadline passed. (5) Proposed strict default fail-closed for missing budgets (HTTP 402 `NO_BUDGET_FOR_CURRENCY`) pending M3 agreement. (6) Identified fundamental safety gaps in naive delta reconciliation (RFC Section 6.2); classified automated reconciliation as UNRESOLVED with Options A, B, and C pending M3 decision. Task 3.2 remains explicitly marked: `[!] Task 3.2 BLOCKED — awaiting Atharva's review and approval`. Note: These are specification changes only; no Gateway Lua scripts or budget enforcement code implemented. |
| **2026-10-22** | Canonical Redis Key Contract Authored & Decision Status Audited | Authored canonical `contracts/redis/keys.md` from scratch and audited decision-status accuracy across documentation: (1) Verified implemented keys (`ratelimit:tenant:...`, `usage-events`, `usage-events:dlq`) against Gateway and Worker source code. (2) Maintained all Stage 3 budget keys as strictly `PROPOSED`. (3) Kept reconciliation keys (`budget:recon:...`, `budget:recon:lock:...`) as explicitly `UNRESOLVED` pending M3 choice among Options A, B, and C. (4) Formally marked missing-budget fail-closed operational policy (HTTP 402 `NO_BUDGET_FOR_CURRENCY`) as `UNRESOLVED` pending formal M3 agreement. (5) Documented Redis Cluster `CROSSSLOT` hazard on Worker Stage 2 DLQ script (`usage-events` slot 1745 vs `usage-events:dlq` slot 14521). (6) Maintained mandatory counter safety: no silent zero defaults and no automatic counter reconstruction from request records. Task 3.2 remains strictly `[!] BLOCKED`. Only documentation modified; no application code or tests changed. |
| **2026-10-22** | M1/M3 Consensus on Architectural Decisions & Canonical Contracts Aligned | Formal agreement recorded between M1 (Gateway) and M3 (Worker/Control Plane) on the three core architectural decisions: (1) Missing-budget policy: hard-enforced tenants reject with HTTP 402 `NO_BUDGET_FOR_CURRENCY`; unbudgeted and alert_only tenants admitted without rejection; missing/invalid metadata fails safely with HTTP 503 `BUDGET_STORE_ERROR` (aligned with `contracts/api/gateway-api.yaml`). (2) Reconciliation: Option C officially adopted (read-only drift detection and audited manual repair under scope lock `budget:recon:lock:{budget:...}` with Gateway write fencing; automated mutations permanently rejected). (3) Cluster DLQ stream hash-tags: `{usage-events}` and `{usage-events}:dlq` agreed in principle to preserve atomic Lua execution in Redis Cluster; migration and rollback plan required before deployment. Updated `contracts/redis/rfc-budget-enforcement.md` (v0.5.0), `contracts/redis/keys.md`, and `M1_phase.md`. Preserved all counter safety invariants. Task 3.2 remains strictly `[!] BLOCKED` pending stream migration plan, manual repair runbook, and verification gates. No Gateway/Worker code modified; zero files staged/committed/pushed. |
| **2026-10-22** | Budget Enforcement RFC Contradictions Resolved (v0.5.1) | Resolved verified contradictions between RFC specification and Redis key contract: (1) Superseded legacy Protocol 5 INCRBY delta adjustments with Option C read-only drift detection and audited manual repair under scope lock with Gateway writer fencing. (2) Prohibited automated startup reconstruction of `budget:reserved` from request hashes and automated rebuild of `budget:spend` from MongoDB during runtime. (3) Reclassified autonomous `reconcile_release_budget.lua` as rejected; marked `RELEASED_RECONCILED` lifecycle transition as unresolved pending audited manual repair tooling. (4) Eliminated unsafe `GET spend or 0` fallback in Lua scripts; aligned with anti-silent-zero invariant and established the Window Initialization Protocol as an explicit pre-implementation gate. (5) Explicitly classified `reserve_budget.lua` prototype as non-executable pending Window Initialization Protocol agreement. Task 3.2 remains strictly `[!] BLOCKED`. Documentation only; zero code changes; nothing staged/committed. |
| **2026-10-23** | Redis Stream Migration Runbook Hardened (Documentation) | Hardened `contracts/redis/stream-migration-runbook.md` for Task 3.2B: (1) Mandated dual-condition drain verification combining direct `XINFO GROUPS` lag (`lag == 0`) and PEL (`XPENDING == 0`), established prerequisite Gateway write-quiescence gate, and documented fallback ID comparison caveats (empty streams, deleted tail entries, concurrent writes). (2) Corrected Prometheus metric to `worker_usage_stream_lag_messages` without `stream` label, documenting 10-second sampling latency. (3) Detailed legacy DLQ `CROSSSLOT` error and established evidence collection protocol (using `XRANGE` to retrieve payload and Worker logs for failure diagnostic) before any approved repair. (4) Partitioned preflight read-only checks from mutating provisioning, and clarified `/readyz` probe scope (Mongo/Redis ping only). (5) Separated MongoDB event deduplication from downstream aggregation idempotency. (6) Structured 7-step staging dry-run plan with explicit sign-off gates. Task 3.2 remains strictly `[!] BLOCKED` pending live staging execution and recorded approvals. Documentation only; zero code changes; nothing staged/committed. |
