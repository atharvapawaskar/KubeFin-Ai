# PHASES.md — Implementation Phases

Dependency-driven, not calendar-driven. Each phase lists goal, dependencies, major tasks, owner, integration points, and completion criteria.

---

## Phase 0 — Foundation

**Goal**: Repository, CI, local dev environment, and contracts structure ready.

**Dependencies**: None

**Major Tasks**:
- Initialize repository with structure (this scaffold)
- CI workflow (lint, structure validation)
- Local docker-compose (MongoDB + Redis)
- Contracts folder structure with README
- Decide open questions (PRD § Open Questions)
- Branch protection rules on main

**Owner**: All (Atharva leads CI/infra)

**Integration Points**: None

**Completion Criteria**:
- `docker compose up` starts MongoDB + Redis healthy
- CI passes on main
- Contracts folder structure exists with README
- Team agrees on auth model, pricing source, multi-tenancy approach

---

## Phase 1 — Gateway MVP

**Goal**: Gateway accepts OpenAI-compatible requests, forwards to one provider, emits usage events.

**Dependencies**: Phase 0

**Major Tasks**:
- Gateway project scaffold (Node.js/TypeScript, Express/Fastify)
- `/v1/chat/completions` endpoint (OpenAI-compatible)
- OpenAI provider adapter
- API key authentication → tenant identity
- Emit usage event to Redis Streams (`usage-events`)
- Unit tests for adapter + identity + event emission

**Owner**: Vedant (M1)

**Integration Points**:
- Redis Streams (event emission)
- Provider API (OpenAI)

**Completion Criteria**:
- `curl /v1/chat/completions` returns provider response
- Usage event appears in Redis Streams
- Tests pass

---

## Phase 2 — Usage Event Pipeline

**Goal**: Worker consumes events from Redis Streams, validates, enriches.

**Dependencies**: Phase 0 (Redis Streams), Phase 1 (event schema)

**Major Tasks**:
- Worker project scaffold (Node.js/TypeScript)
- Redis Streams consumer group for `usage-events`
- Event validation (JSON Schema)
- Event enrichment (add metadata, timestamps)
- Dead letter handling for invalid events
- Exactly-once processing via consumer groups

**Owner**: Atharva (M3)

**Integration Points**:
- Redis Streams (consumer)
- Contracts: `contracts/events/usage-event.json`

**Completion Criteria**:
- Events flow Gateway → Redis Streams → Worker
- Invalid events go to DLQ
- No event loss on restart

---

## Phase 3 — Cost Calculation

**Goal**: Worker calculates token cost per event using provider pricing.

**Dependencies**: Phase 2

**Major Tasks**:
- Pricing table (provider/model → cost per 1K tokens)
- Cost engine: input_tokens × rate + output_tokens × rate
- Infra cost attribution (optional, placeholder)
- Unit tests for cost calculation accuracy

**Owner**: Atharva (M3)

**Integration Points**:
- Contracts: `contracts/db/pricing.json`
- Worker event processor

**Completion Criteria**:
- Each event enriched with `cost_usd` field
- Accuracy verified against provider billing (100%)

---

## Phase 4 — Persistence and Aggregation

**Goal**: Store raw events and hourly/daily rollups in MongoDB.

**Dependencies**: Phase 3

**Major Tasks**:
- MongoDB collections: `usage_events` (time-series), `cost_aggregations`
- Write raw events with TTL
- Hourly rollup job (tenant, team, workload, provider, model)
- Daily rollup job
- Basic aggregation query API

**Owner**: Atharva (M3)

**Integration Points**:
- MongoDB
- Contracts: `contracts/db/usage-events.json`, `contracts/db/cost-aggregations.json`

**Completion Criteria**:
- Events persisted with TTL
- Rollups queryable via API
- Query returns correct spend by tenant/provider/model

---

## Phase 5 — Dashboard MVP

**Goal**: Frontend displays real spend data from Control Plane API.

**Dependencies**: Phase 4 (aggregation API)

**Major Tasks**:
- Frontend scaffold (React + TypeScript + Vite)
- Control Plane API scaffold (Express/Fastify)
- `/api/v1/analytics/spend` endpoint
- FinOps Dashboard page (total spend, daily trend, top workloads)
- Spend Analysis page (breakdown by tenant/team/workload/provider/model)

**Owner**: Om (M2) + Atharva (M3) for API

**Integration Points**:
- Control Plane API → MongoDB aggregations
- Contracts: `contracts/api/control-plane-api.yaml`

**Completion Criteria**:
- Dashboard loads and shows real data
- Spend breakdown filters work
- No hardcoded/mock data

---

## Phase 6 — Policies and Budgets

**Goal**: Gateway enforces rate limits, budgets, and model policies.

**Dependencies**: Phase 1 (Gateway scaffold), Phase 4 (budget data)

**Major Tasks**:
- Rate limiting middleware (Redis token bucket per tenant/workload)
- Budget enforcement middleware (Redis counter, 402 on exceed)
- Policy engine (model allow-list, max tokens per request)
- Budget CRUD in Control Plane API
- Budget Management page in Dashboard
- Integration tests (429, 402 responses)

**Owner**: Vedant (M1) + Atharva (M3) for budget API + Om (M2) for UI

**Integration Points**:
- Redis (counters)
- Contracts: `contracts/redis/keys.md`, `contracts/db/budgets.json`
- Control Plane API

**Completion Criteria**:
- Requests over rate limit → 429
- Requests over budget → 402
- Budgets creatable/editable via Dashboard
- Policies enforced per tenant

---

## Phase 7 — Kubernetes Integration

**Goal**: Auto-discover workloads from Kubernetes, map to identities.

**Dependencies**: Phase 0 (K8s access), Phase 1 (Gateway identity)

**Major Tasks**:
- K8s API watcher (pods, labels, annotations)
- ServiceAccount → workload identity mapping
- Sync metadata to Gateway (identity resolution)
- Sync metadata to Worker (enrichment)
- Workload selector in Dashboard

**Owner**: Atharva (M3)

**Integration Points**:
- Kubernetes API
- Gateway identity middleware
- Worker event enrichment
- Contracts: `contracts/db/workloads.json` (future)

**Completion Criteria**:
- New pods appear in Dashboard with correct identity
- Usage events carry `workloadId` from K8s
- No manual workload registration needed

---

## Phase 8 — Optimization and Recommendations

**Goal**: Generate actionable cost/performance recommendations.

**Dependencies**: Phase 4 (aggregations), Phase 5 (Dashboard)

**Major Tasks**:
- Model optimization (cheaper model for similar quality)
- Provider optimization (cost vs latency tradeoff)
- Cache optimization (identify cacheable workloads)
- Recommendations API endpoint
- Optimization page in Dashboard
- Estimated savings calculation

**Owner**: Atharva (M3) + Om (M2) for UI

**Integration Points**:
- MongoDB aggregations
- Control Plane API
- Contracts: `contracts/db/recommendations.json`

**Completion Criteria**:
- Dashboard shows ranked recommendations with $ savings
- Recommendations actionable (model swap, provider switch)
- Savings estimates documented

---

## Phase 9 — Deployment and Observability

**Goal**: Production-ready deployment with full observability.

**Dependencies**: All prior phases

**Major Tasks**:
- Helm charts for Gateway, Worker, API, Frontend
- K8s manifests (Deployment, Service, Ingress, HPA)
- Prometheus metrics + Grafana dashboards
- OpenTelemetry tracing (gateway → provider, gateway → Redis → worker)
- Structured logging (JSON) → Loki
- Alert rules (budget > 80%, p99 > 200ms, lag > 60s)

**Owner**: Atharva (M3) + Vedant (M1) for gateway metrics

**Integration Points**:
- Kubernetes
- Prometheus/Grafana/Loki/Tempo
- All services

**Completion Criteria**:
- `helm install` deploys full stack
- Dashboards show live metrics
- Traces connect gateway → worker
- Alerts fire on thresholds

---

## Phase 10 — Hardening and Final Integration

**Goal**: End-to-end reliability, security, and documentation.

**Dependencies**: All prior phases

**Major Tasks**:
- Load test (gateway p99 < 50ms overhead)
- Security audit (secrets, network policies, RBAC)
- Chaos testing (provider failure, Redis failover)
- Runbook + incident response docs
- Final contract freeze (v1 schemas)
- Team retrospective

**Owner**: All

**Integration Points**: Full stack

**Completion Criteria**:
- Load test passes
- Security audit clean
- Failover works
- Runbooks complete
- Contracts v1 tagged

---

## Dependency Graph

```
Phase 0
  │
  ├── Phase 1 (Gateway MVP) ──▶ Phase 2 (Event Pipeline) ──▶ Phase 3 (Cost) ──▶ Phase 4 (Persistence)
  │       │                           │                        │                   │
  │       │                           │                        │                   ├── Phase 5 (Dashboard)
  │       │                           │                        │                   │
  │       ├── Phase 6 (Policies/Budgets) ◀────────────────────┘                   │
  │       │                                                                       │
  │       └── Phase 7 (K8s Integration) ──────────────────────────────────────────┘
  │
  ├── Phase 8 (Optimization) ◀────────────────────────────────────────────────────┘
  │
  ├── Phase 9 (Deployment/Observability)
  │
  └── Phase 10 (Hardening)
```

---

## Member 3 (Atharva) Work Summary

| Phase | Primary Work |
|-------|--------------|
| 0 | CI, docker-compose, infra decisions |
| 2 | Redis Streams consumer, event validation |
| 3 | Cost engine, pricing tables |
| 4 | MongoDB persistence, aggregation jobs |
| 5 | Control Plane API |
| 6 | Budget API |
| 7 | K8s watcher, identity sync |
| 8 | Recommendation engine |
| 9 | Helm, K8s manifests, Prometheus/Grafana/OTel |
| 10 | Load test, security audit, chaos testing |