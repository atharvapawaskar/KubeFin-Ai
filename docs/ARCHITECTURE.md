# ARCHITECTURE.md — System Architecture

## A. System Overview

Kubefin is a Kubernetes-native AI FinOps platform with two planes:

- **Data Plane (Gateway)**: Synchronous request path — low latency, high throughput
- **Control Plane (Worker + API + Dashboard)**: Asynchronous processing — cost calculation, aggregation, visualization

## B. Logical Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        KUBEFIN PLATFORM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────────────────────────────┐  │
│  │  CONSUMERS   │───▶│           DATA PLANE                  │  │
│  │ (Apps/SDKs)  │    │  services/gateway/                    │  │
│  └──────────────┘    │  ┌──────────┐ ┌────────┐ ┌────────┐  │  │
│                      │  │ Identity │ │ Policy │ │ Router │  │  │
│                      │  │ Resolution│ │Engine │ │        │  │  │
│                      │  └──────────┘ └────────┘ └────┬───┘  │  │
│                      │         ┌────────┐ ┌────────┐ │       │  │
│                      │         │Rate Lmt│ │ Budget │ │       │  │
│                      │         │        │ │ Enforce│ │       │  │
│                      │         └────────┘ └────────┘ │       │  │
│                      │         ┌────────────────────┐  │       │  │
│                      │         │ Provider Adapters  │  │       │  │
│                      │         │ OpenAI/Anthropic/  │  │       │  │
│                      │         │ Ollama             │  │       │  │
│                      │         └─────────┬──────────┘  │       │  │
│                      └───────────────────┼──────────────┘       │
│                                          │                       │
│                              Redis Streams (usage-events)      │
│                                          ▼                       │
│  ┌──────────────┐    ┌──────────────────────────────────────┐  │
│  │  FRONTEND    │◀───│           CONTROL PLANE               │  │
│  │ (Dashboard)  │    │  services/worker/ + API               │  │
│  └──────────────┘    │  ┌──────────────┐ ┌──────────┐       │  │
│                      │  │ Event        │ │ Cost     │       │  │
│                      │  │ Processor    │ │ Engine   │       │  │
│                      │  └──────────────┘ └──────────┘       │  │
│                      │  ┌──────────────┐ ┌──────────────┐   │  │
│                      │  │ Aggregation  │ │ Control Plane│   │  │
│                      │  │ Engine       │ │ API (REST)   │   │  │
│                      │  └──────────────┘ └──────────────┘   │  │
│                      └───────────────────┼──────────────────┘  │
│                                          │                     │
│                              MongoDB (Time-series)            │
│                                          ▼                     │
└─────────────────────────────────────────────────────────────────┘
```

## C. Synchronous Request Flow

```
Application
    │
    ▼
Gateway: Authentication / Identity Resolution
    │   (API Key → tenantId, teamId, workloadId)
    ▼
Gateway: Policy Evaluation
    │   (Model allow-list, max tokens, request validation)
    ▼
Gateway: Rate Limit Check
    │   (Redis token bucket per tenant/workload)
    ▼
Gateway: Budget Check
    │   (Redis counter, reject if exceeded)
    ▼
Gateway: Provider Routing
    │   (Policy-based: cost, latency, capability)
    ▼
Gateway: Provider Adapter → AI Provider
    │   (OpenAI / Anthropic / Ollama)
    ▼
Gateway: Emit Usage Event → Redis Streams (async, non-blocking)
    │
    ▼
Return Response to Application
```

## D. Asynchronous Usage Flow

```
Gateway
    │
    ▼ (emit)
Redis Streams: usage-events (partitioned by tenantId)
    │
    ▼ (consume)
Worker: Event Processor
    │   - Validate event schema
    │   - Enrich with metadata
    ▼
Worker: Cost Engine
    │   - Token cost (input/output × provider pricing)
    │   - Infrastructure cost (optional)
    ▼
Worker: Aggregation Engine
    │   - Hourly/daily rollups by tenant, team, workload, provider, model
    ▼
MongoDB: Collections
    │   - usage_events (raw, time-series)
    │   - cost_aggregations (rollups)
    │   - pricing (provider/model tables)
    ▼
Control Plane API reads aggregations
    │
    ▼
Frontend Dashboard visualizes data
```

## E. Component Responsibilities

### Gateway (`services/gateway/`) — Owner: Vedant (M1)
| Module | Responsibility |
|--------|----------------|
| `middleware/identity` | API key → tenantId, teamId, workloadId |
| `middleware/policy` | Allow/deny rules, model allow-list, max tokens |
| `middleware/ratelimit` | Token bucket per tenant/workload (Redis) |
| `middleware/budget` | Spend counter, reject if exceeded (Redis) |
| `router/` | Select provider/model by policy, health, cost |
| `adapters/` | Provider-specific request/response translation |
| `reliability/` | Circuit breaker, retry, fallback |

**Non-functional**: p99 < 50ms overhead, stateless, horizontal scaling

### Worker (`services/worker/`) — Owner: Atharva (M3)
| Module | Responsibility |
|--------|----------------|
| `event-processor/` | Consume Redis Streams, validate, enrich |
| `cost-engine/` | Calculate token + infra cost |
| `aggregation-engine/` | Hourly/daily rollups |

**Non-functional**: Event lag < 30s, exactly-once semantics

### Frontend (`frontend/`) — Owner: Om (M2)
React + TypeScript dashboard consuming Control Plane API. Pages: FinOps overview, Spend Analysis, Workload Insights, Budget Management, Optimization.

### MongoDB
Time-series collections: `usage_events`, `cost_aggregations`, `pricing`, `policies`, `budgets`, `audit_logs`

### Redis
- Redis Streams: `usage-events` (partitioned by tenantId)
- Rate limiting counters
- Budget counters
- Caching (future)

### Kubernetes Integration (Phase 7+)
- K8s API watcher for pod labels/annotations
- ServiceAccount → workload identity mapping
- Sync metadata to Gateway/Worker

### AI Provider Adapters
Pluggable adapters for OpenAI, Anthropic, Ollama (vLLM/TGI future)

## F. Data Flow Summary

| Flow | Mechanism | Latency Target |
|------|-----------|----------------|
| Request → Response | HTTP (sync) | < 50ms overhead |
| Gateway → Event | Redis Streams (async) | Non-blocking |
| Event → MongoDB | Worker processing | < 30s lag |
| MongoDB → Dashboard | REST API | < 2s query |

## G. Control Flow

| Trigger | Path |
|---------|------|
| Consumer request | Gateway middleware chain → provider → response |
| Budget exceeded | Gateway middleware → 402 response |
| Rate limit hit | Gateway middleware → 429 response |
| Provider failure | Gateway reliability → circuit breaker → fallback |
| New usage event | Redis Streams → Worker → MongoDB → aggregations |
| Scheduled rollup | Worker cron → aggregation engine → cost_aggregations |

## H. Failure/Error Handling

- **Gateway**: Circuit breaker per provider, exponential backoff, fallback to secondary provider
- **Worker**: Dead letter queue for failed events, retry with backoff, idempotent processing
- **MongoDB**: Replica set, time-series collections with TTL
- **Redis**: Redis Streams consumer groups for exactly-once, persistence enabled

## I. Security Principles

- Transport: mTLS between services, TLS at ingress
- Auth: API keys (gateway), JWT/OIDC (control plane API — future)
- Secrets: Kubernetes Secrets, never in repo or logs
- PII: Optional gateway middleware, never logged
- Audit: All gateway decisions logged to `audit_logs` collection

## J. Deployment Architecture (High Level)

- Kubernetes (EKS/GKE/AKS) — Helm charts
- Gateway: Deployment + HPA (CPU + custom metrics)
- Worker: Deployment (consumer group scaling)
- Control Plane API: Deployment
- Frontend: Deployment + Ingress
- MongoDB: Atlas or self-hosted replica set
- Redis: Redis Cluster or managed (ElastiCache, etc.)

## K. Observability (High Level)

- **Metrics**: Prometheus — gateway latency, error rate, rate limit hits, budget rejections; worker event lag, processing time
- **Logs**: Structured JSON → Loki — correlation IDs across gateway → worker
- **Traces**: OpenTelemetry → Tempo/Jaeger — full request trace
- **Alerts**: Budget > 80%, gateway p99 > 200ms, event lag > 60s, provider error rate > 5%

## L. MVP Boundaries

| In MVP | Deferred |
|--------|----------|
| Redis Streams | Kafka |
| MongoDB | Hard multi-tenancy |
| OpenAI/Anthropic/Ollama adapters | vLLM/TGI, fine-tuning |
| Basic cost + aggregation | RL-based routing |
| Single-region deployment | Multi-region, DR |

## M. Future Work

- Kafka for higher throughput / replay
- Hard multi-tenancy (namespace isolation)
- OAuth/OIDC for consumer auth
- vLLM/TGI support for self-hosted models
- Advanced optimization (ML-based routing)
- Custom model hosting orchestration

---

## Decisions (2026-10-04)

1. **Redis Streams is the MVP asynchronous event processing mechanism** — simpler operational model, sufficient for initial throughput.
2. **Kafka is deferred** — not part of MVP; will be evaluated when throughput exceeds Redis Streams capacity or replay/retention needs grow.
3. **Modular architecture with Gateway, Worker, Frontend, MongoDB, and Redis** — clear ownership boundaries for 3-person team.
4. **Shared interfaces maintained under `contracts/`** — API (OpenAPI), events (JSON Schema), DB (collection schemas), Redis (key conventions).
5. **Architecture remains simple enough for 2–3 week vertical slice** — Phase 0-3 deliver end-to-end flow: request → gateway → provider → event → worker → MongoDB → dashboard.