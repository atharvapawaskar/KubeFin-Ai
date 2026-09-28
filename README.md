# Kubernetes-Native AI FinOps Platform - System Architecture

> End-to-end view: from AI request to cost attribution, analytics and optimization.

## Contents

- [Overview](#overview)
- [Design principles](#design-principles)
- [Request lifecycle](#request-lifecycle)
- [1. AI Consumers](#1-ai-consumers)
- [2. API Edge / Ingress](#2-api-edge--ingress)
- [3. AI Gateway (data plane)](#3-ai-gateway-data-plane)
- [4. AI Providers](#4-ai-providers)
- [5. Control / FinOps Plane](#5-control--finops-plane)
- [Frontend](#frontend-react-dashboard)
- [Data Layer](#data-layer)
- [Observability](#observability)

---

## Overview

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 1. AI CONSUMERS  (Kubernetes workloads)                                              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Web Apps  •  Internal APIs  •  Batch Jobs (CronJobs)  •  AI Agents (tools/workers)   │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                           │  HTTPS (OpenAI-compatible API)
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 2. API EDGE / INGRESS  (Kubernetes Ingress)                                          │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ TLS Termination → Authentication (API Key / OAuth) → WAF / Rate Limit → Routing      │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────┐    ┌────────────────────────────────┐
│ 3. AI GATEWAY  (data plane, real-time)         │    │ 4. AI PROVIDERS                │
├────────────────────────────────────────────────┤    ├────────────────────────────────┤
│ Identity Resolution                            │    │ • OpenAI (GPT-4, GPT-4o, ...)  │
│  ↓ Policy Engine                               │ ─▶ │ • Anthropic (Claude 3 / 3.5)   │
│  ↓ Rate Limiting                               │    │ • Ollama (self-hosted: Llama,  │
│  ↓ Budget Enforcement                          │    │   Mistral, Gemma)              │
│  ↓ PII / DLP Security                          │    │ • Future providers (adapter)   │
│  ↓ Cache (Redis)                               │    └────────────────────────────────┘
│  ↓ Model / Provider Router                     │
│  ↓ Reliability (Circuit Breaker)               │
│  ↓ Provider Adapter                            │
└────────────────────────────────────────────────┘
                        ┆  emit usage event (async)
                        ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 5. CONTROL / FINOPS PLANE  (asynchronous)                                            │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ K8s Integration → Usage Events → Cost Engine → Analytics → Optimization              │
│ Control Plane API: Identity | Policy | Budget | Provider | Pricing | Optimization    │
└──────────────────────────────────────────────────────────────────────────────────────┘
                     ▲▼  REST (HTTPS)                             ▲▼  read / write
┌─────────────────────────────────────────┐  ┌─────────────────────────────────────────┐
│ FRONTEND  (React Dashboard)             │  │ DATA LAYER                              │
├─────────────────────────────────────────┤  ├─────────────────────────────────────────┤
│ FinOps Dashboard  •  Spend Analysis     │  │ MongoDB  - primary data store           │
│ Workload Insights  •  Budget Management │  │ Redis    - low-latency state            │
│ Optimization Recommendations            │  │ (cache, limits, budget counters,        │
│ Provider Performance                    │  │  provider health, sessions)             │
└─────────────────────────────────────────┘  └─────────────────────────────────────────┘
                                           │  metrics / traces / logs from every layer
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ OBSERVABILITY & PLATFORM SERVICES                                                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Prometheus • Grafana • OpenTelemetry • Loki/ELK • Alerting                           │
│ Kubernetes • Helm • Secrets (Vault / K8s) • CI/CD                                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Two planes, on purpose:**

| Plane | Runs | Goal |
|---|---|---|
| **Data plane** (AI Gateway) | Synchronously on every request | Low latency, enforcement (policy, rate limit, budget, PII) |
| **Control / FinOps plane** | Asynchronously from usage events | Cost, analytics, optimization - never blocks a request |

---

## Design principles

- **Data plane / control plane separation** - the gateway is real-time; FinOps processing is asynchronous.
- **Kubernetes-native identity** - costs are attributed via `ServiceAccount → Workload → Application → Team → Tenant`.
- **Provider-agnostic** - new providers plug in through the Provider Adapter.
- **Low-latency state in Redis**, durable data in MongoDB.
- **OpenAI-compatible API** - consumers switch to the gateway without code changes.

---

## Request lifecycle

```text
Client
  │  1. HTTPS request (OpenAI-compatible)
  ▼
Ingress ── TLS ── AuthN ── WAF / rate limit ── Routing
  │
  ▼
AI Gateway
  │  2. Resolve identity  (ServiceAccount → Workload → App → Team → Tenant)
  │  3. Policy check, rate limit, budget check      ◀── Redis (counters, limits)
  │  4. PII / DLP scan
  │  5. Cache lookup ─────────── hit ───────────────▶ return cached response
  │           │ miss
  │  6. Pick model / provider (router + circuit breaker state)
  ▼
Provider Adapter ──▶ OpenAI | Anthropic | Ollama | future providers
  │
  ▼
Response ──▶ Client
  ┆
  ┆  7. Emit usage event (async, non-blocking)
  ▼
Event Queue ──▶ Event Processor ──▶ Cost Engine ──▶ Analytics ──▶ Optimization
                                                       │
                                                       ▼
                                                 MongoDB (usage, cost, recommendations)
```

---

## 1. AI Consumers

Workloads running in Kubernetes that call AI services through an OpenAI-compatible API over HTTPS.

| Consumer | Description |
|---|---|
| Web Applications | Frontend / backend apps |
| Internal APIs | Microservices |
| Batch Jobs | CronJobs |
| AI Agents | Tools / workers |

## 2. API Edge / Ingress

| Component | Responsibility |
|---|---|
| Kubernetes Ingress (API Gateway) | Cluster entry point |
| TLS Termination | Encrypts / decrypts traffic |
| Authentication | API Key / OAuth |
| Request Protection | WAF / rate limit |
| Routing | Forwards requests to the AI Gateway |

## 3. AI Gateway (data plane)

| # | Component | Purpose |
|---|---|---|
| 1 | Identity Resolution | Map caller to tenant / team / app / workload |
| 2 | Policy Engine | Apply access and usage policies |
| 3 | Rate Limiting | Enforce request limits |
| 4 | Budget Enforcement | Allow / block based on budget counters |
| 5 | PII / DLP Security | Detect and protect sensitive data |
| 6 | Cache (Redis) | Serve repeated requests from cache |
| 7 | Model / Provider Router | Choose model and provider |
| 8 | Reliability (Circuit Breaker) | Failover and resilience |
| 9 | Provider Adapter | Translate to provider-specific API |

After responding, the gateway **emits a usage event asynchronously** to the FinOps plane.

## 4. AI Providers

| Provider | Models |
|---|---|
| OpenAI | GPT-4, GPT-4o, GPT-3.5, etc. |
| Anthropic | Claude 3, Claude 3.5, etc. |
| Ollama (self-hosted) | Llama, Mistral, Gemma, etc. |
| Future providers | Extensible via Provider Adapter |

## 5. Control / FinOps Plane

```text
┌────────────────────────────────────────────────────────────────────┐
│ Kubernetes Integration Layer                                       │
├────────────────────────────────────────────────────────────────────┤
│ Kubernetes API        (watches / informers)                        │
│ Workload Metadata     (CRDs / labels / annotations)                │
│ Identity Registry     ServiceAccount → Workload → Application      │
│                       → Team → Tenant                              │
└────────────────────────────────────────────────────────────────────┘
                                  │  sync workload metadata (periodic)
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Usage Event Layer                                                  │
├────────────────────────────────────────────────────────────────────┤
│ Event Queue           (Kafka / Redis Streams)                      │
│ Event Processor       (consumers)                                  │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Cost Engine                                                        │
├────────────────────────────────────────────────────────────────────┤
│ Token Cost Calculation   (OpenAI / Anthropic)                      │
│ Infrastructure Cost      (self-hosted / Ollama)                    │
│ Pricing Management       (versioned)                               │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Analytics Engine                                                   │
├────────────────────────────────────────────────────────────────────┤
│ Usage Aggregation (by tenant / team / app / workload)              │
│ Trend Analysis  •  Provider Reliability                            │
│ Cache Savings   •  Cost Attribution                                │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Optimization Engine                                                │
├────────────────────────────────────────────────────────────────────┤
│ Model Optimization      (select better models)                     │
│ Cache Optimization      (identify cache opportunities)             │
│ Provider Optimization   (cost, latency, reliability)               │
│ Estimated Savings       (actionable recommendations)               │
└────────────────────────────────────────────────────────────────────┘
                                  │  recommendations / savings
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Control Plane API                                                  │
├────────────────────────────────────────────────────────────────────┤
│ Identity | Policy | Budget | Provider | Pricing | Optimization     │
└────────────────────────────────────────────────────────────────────┘
```

| Engine | Key capabilities |
|---|---|
| Kubernetes Integration Layer | Watches K8s API, reads CRDs / labels / annotations, maintains the identity registry |
| Usage Event Layer | Kafka / Redis Streams queue plus consumers |
| Cost Engine | Token cost (OpenAI / Anthropic), infrastructure cost (self-hosted), versioned pricing |
| Analytics Engine | Aggregation by tenant / team / app / workload, trends, provider reliability, cache savings, cost attribution |
| Optimization Engine | Model, cache and provider optimization, estimated savings |
| Control Plane API | Identity, policy, budget, provider, pricing and optimization management |

## Frontend (React Dashboard)

Talks to the Control Plane API over REST (HTTPS).

| View | Purpose |
|---|---|
| FinOps Dashboard | Top-level spend and usage |
| Spend Analysis | By tenant / team / application |
| Workload Insights | Kubernetes view |
| Budget Management | Set and track budgets |
| Optimization Recommendations | Actionable savings |
| Provider Performance | Latency, cost, reliability per provider |

## Data Layer

| Store | Role | Contents |
|---|---|---|
| **MongoDB** | Primary data store | Tenants, Teams, Applications, Workloads, Usage Events, Pricing, Policies, Audit Logs, Recommendations |
| **Redis** | Low-latency state | Cache, Rate Limits, Budget Counters, Provider Health, Temporary State, Sessions |

---

## Observability

Observability covers both layers: the real-time gateway and the async FinOps pipeline.

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ SIGNAL SOURCES                                                                       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ AI Gateway • Event Processors • Control Plane API • Kubernetes • Redis / MongoDB     │
└──────────────────────────────────────────────────────────────────────────────────────┘
              ▼                             ▼                             ▼
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ Prometheus               │  │ OpenTelemetry            │  │ Loki / ELK               │
├──────────────────────────┤  ├──────────────────────────┤  ├──────────────────────────┤
│ METRICS                  │  │ TRACES                   │  │ LOGS                     │
│ scrape / alert rules     │  │ request-level spans      │  │ structured, searchable   │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
              └─────────────────────────────┬─────────────────────────────┘
                                            ▼
                             ┌────────────────────────────┐
                             │ Grafana                    │
                             ├────────────────────────────┤
                             │ dashboards (visualization) │
                             └────────────────────────────┘
                                            ▼
                             ┌────────────────────────────┐
                             │ Monitoring & Alerting      │
                             ├────────────────────────────┤
                             │ platform + business alerts │
                             └────────────────────────────┘
```

### Tooling

| Tool | Signal | Role in this platform |
|---|---|---|
| Prometheus | Metrics | Scrapes gateway, processors, API, Redis, MongoDB and Kubernetes |
| OpenTelemetry | Traces | End-to-end spans: ingress → gateway → provider, plus event processing |
| Loki / ELK | Logs | Gateway, processor and audit logs |
| Grafana | Visualization | Platform dashboards and business dashboards |
| Monitoring & Alerting | Alerts | Platform health and business (budget / cost) alerts |
| Kubernetes | Orchestration | Health probes, pod / node metrics |
| Helm | Deployment | Versioned releases |
| Secrets Management | Security | Vault / Kubernetes Secrets for provider keys |
| CI/CD | Delivery | Deployment pipeline |

### Suggested key metrics

> These are recommendations for instrumenting the platform, not part of the original diagram.

| Area | Metric |
|---|---|
| Gateway | Request rate, p50 / p95 / p99 latency, error rate by provider |
| Cache | Hit ratio, tokens / cost saved |
| Enforcement | Rate-limit rejections, budget rejections, PII / DLP blocks |
| Providers | Error rate, timeout rate, circuit-breaker state, latency per model |
| Event pipeline | Queue lag, processing rate, failed / retried events |
| Cost | Cost per tenant / team / app, token usage per model, budget burn rate |
| Data stores | Redis memory and evictions, MongoDB latency and connections |

### Suggested alerts

| Alert | Type |
|---|---|
| Gateway p95 latency or error rate above threshold | Platform |
| Circuit breaker open for a provider | Platform |
| Event queue lag growing | Platform |
| Budget at 80% / 100% | Business |
| Sudden cost spike for a tenant or model | Business |
| Cache hit ratio drops sharply | Business |
