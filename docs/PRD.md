# PRD — Product Requirements Document

## Problem

Organizations adopting AI/LLM capabilities face:
- **No visibility** into which teams, applications, or Kubernetes workloads consume tokens
- **No centralized governance** for model access, rate limits, or budgets
- **Uncontrolled costs** with no attribution to business units
- **Provider lock-in** with no routing based on cost, latency, or capability
- **Compliance gaps** — PII leakage, audit requirements unmet

## Target Users

- **Platform Engineers** — need reliability, observability, Kubernetes integration
- **FinOps / Finance** — need cost attribution, budgets, forecasting
- **ML Engineers** — need model experimentation, latency tracking
- **Security / Compliance** — need PII redaction, audit logs, policy enforcement

## Product Goal

A Kubernetes-native gateway and control plane that provides:
1. **Access control** — who can call which models
2. **Policy enforcement** — rate limits, budgets, model allow-lists
3. **Usage monitoring** — real-time visibility into AI consumption
4. **Cost tracking** — per-team, per-workload, per-model spend
5. **Provider routing** — send requests to optimal provider/model
6. **Optimization** — recommendations for cost/performance

## Core Features (MVP)

### Gateway (Data Plane)
- OpenAI-compatible `/v1/chat/completions` endpoint
- API key authentication → tenant/workload identity
- Policy engine: model allow-list, max tokens, request validation
- Rate limiting (token bucket per tenant/workload)
- Budget enforcement (hard limits, Redis counters)
- Provider routing (OpenAI, Anthropic, Ollama)
- Usage event emission to Redis Streams

### Worker (Control Plane)
- Consume usage events from Redis Streams
- Token cost calculation (provider pricing tables)
- Time-series aggregations (hourly/daily rollups)
- Persist to MongoDB

### Control Plane API
- Spend analytics endpoints
- Budget CRUD + alerting

### Frontend Dashboard
- FinOps overview (total spend, trends)
- Spend analysis (by tenant/team/workload/provider/model)
- Workload insights (latency, errors, cache hits)
- Budget management (create, track, alerts)

## MVP Scope Boundaries

**In MVP:**
- Single-tenant or soft multi-tenancy
- Redis Streams for event processing
- MongoDB for persistence
- OpenAI + Anthropic + Ollama adapters
- Basic cost calculation + aggregation

**Out of Scope (Post-MVP):**
- Kafka (deferred)
- Fine-tuning management
- Prompt engineering playground
- Multi-cloud provider management
- RL-based routing
- Custom model hosting orchestration
- Hard multi-tenancy (separate clusters)

## Success Metrics

| Metric | Target |
|--------|--------|
| Gateway p99 latency overhead | < 50ms |
| Event processing lag | < 30s |
| Cost calculation accuracy | 100% vs provider bills |
| Dashboard query latency | < 2s |
| Gateway uptime | 99.9% |

## Important Open Questions

1. **Auth model**: API keys only, or OAuth/OIDC for consumers?
2. **Pricing source**: Hardcoded tables, or fetch from provider APIs?
3. **Multi-tenancy**: Hard isolation (separate clusters) or soft (shared)?
4. **Self-hosted models**: Ollama only, or vLLM/TGI support?