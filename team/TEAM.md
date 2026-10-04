# TEAM.md — Team Ownership and Collaboration

## Members

| Member | Role | Primary Ownership |
|--------|------|-------------------|
| **Vedant Rathod** (M1) | Gateway / Backend | `services/gateway/` — authentication, identity resolution, policy enforcement, rate limiting, budget enforcement, provider adapters, model/provider routing, usage event generation |
| **Om Pawar** (M2) | Frontend | `frontend/` — dashboard, visualizations, spend/usage/budget views, workload analytics, optimization UI |
| **Atharva Pawaskar** (M3) | Worker / DevOps | `services/worker/` — Redis Streams consumer, cost calculation, aggregation, recommendations; `deploy/` — Docker, Kubernetes, Helm, infrastructure, observability |

## Shared Ownership

All three members share responsibility for:
- `contracts/` — API schemas, event schemas, DB schemas, Redis key conventions
- `docs/` — PRD, Architecture, Phases
- `team/` — Team documentation
- `CLAUDE.md` — AI behavior rules
- Architecture-changing decisions
- Integration boundaries between components

## Communication Expectations

- **Async-first**: GitHub issues, PR comments, documentation updates
- **Weekly sync**: 30 min call (schedule TBD)
- **Urgent/blocking**: Direct message or call
- **Decisions**: Document in PR or `docs/ARCHITECTURE.md` Decisions section, not in chat

## Dependency Handling

| Dependency | Provider | Consumer | Coordination |
|------------|----------|----------|--------------|
| Usage event schema | Gateway (M1) | Worker (M3) | Contract PR, 2 approvals |
| Control Plane API | Worker (M3) | Frontend (M2) | Contract PR, 2 approvals |
| MongoDB collections | Worker (M3) | Frontend (M2) via API | Schema in contracts/db/ |
| Redis key conventions | Gateway (M1) | Worker (M3) | Contracts/redis/ |
| Workload identity | K8s (M3) | Gateway (M1), Worker (M3) | Phase 7 |

**Rule**: Contract changes require a dedicated PR touching only `contracts/`, with approval from both other members.

## Escalation Path

1. Discuss in PR / GitHub issue
2. Weekly sync
3. Direct call between affected members
4. If unresolved → all three on call, decision documented in ARCHITECTURE.md

## Integration Expectations

- **No silent breaking changes** — contracts are the integration boundary
- **Version schemas** — `usage-event.v1.json`, `v2.json`, etc.
- **Support old version during migration** — deprecation timeline documented
- **CI validates contracts** — schema compilation, example validation
- **Small PRs** — < 300 lines, 1–3 day branches

## Timezone / Availability

All members currently in IST (UTC+5:30). Core hours: 10:00–18:00 IST.