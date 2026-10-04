# Kubefin

**Kubernetes-native AI FinOps / LLM Governance Platform**

## What Kubefin Is

Kubefin sits between your applications and AI model providers. It gives you visibility, control, and cost governance over AI usage across your organization.

## Problem It Solves

- **No visibility** into which teams, applications, or Kubernetes workloads are consuming AI tokens
- **No centralized policy enforcement** for model access, rate limits, or budgets
- **Runaway costs** with no attribution to business units
- **Provider lock-in** with no ability to route requests based on cost, latency, or capability
- **No association** between AI usage and Kubernetes workloads

## High-Level Architecture

```
Application → Kubefin Gateway → AI Provider
                ↓
           Redis Streams
                ↓
              Worker
                ↓
            Cost Calculation → Aggregation → MongoDB
                ↓
            Dashboard / API
```

**Synchronous path**: Application → Gateway → Provider → Application  
**Asynchronous path**: Gateway → Redis Streams → Worker → MongoDB → Dashboard

## Team Ownership

| Member | Role | Primary Ownership |
|--------|------|-------------------|
| Vedant Rathod (M1) | Gateway/Backend | Gateway, auth, policy, rate limiting, budgets, provider adapters, routing, event generation |
| Om Pawar (M2) | Frontend | Dashboard, visualizations, spend/usage/budget views, workload analytics, optimization UI |
| Atharva Pawaskar (M3) | Worker/DevOps | Worker, Redis Streams, cost calc, aggregation, recommendations, Docker, K8s, Helm, observability |

**Shared**: Contracts, architecture decisions, integration boundaries, cross-cutting documentation

## Current Status

**Phase 0 — Foundation**  
Repository structure, documentation, local development environment (MongoDB + Redis), CI foundation.

## Development Structure

```
kubefin/
├── docs/           # PRD, Architecture, Phases
├── team/           # TEAM.md
├── contracts/      # Shared interfaces (api/, events/, db/, redis/)
├── services/       # gateway/, worker/
├── frontend/       # Dashboard
├── deploy/         # docker/, helm/, k8s/
└── .github/        # CI, CODEOWNERS, PR template
```