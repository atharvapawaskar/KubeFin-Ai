# Contracts — Shared Source of Truth

This directory contains all shared interfaces between components. **Contracts are the integration boundary** — no component should depend on another's implementation details.

## Directory Structure

```
contracts/
├── api/          # OpenAPI specifications
│   ├── gateway-api.yaml           # Consumer → Gateway (OpenAI-compatible)
│   └── control-plane-api.yaml     # Frontend → Control Plane API
├── events/       # JSON Schemas for async events
│   └── usage-event.json           # Gateway → Worker (Redis Streams)
├── db/           # MongoDB collection schemas (JSON Schema)
│   ├── usage-events.json
│   ├── cost-aggregations.json
│   ├── pricing.json
│   ├── policies.json
│   ├── budgets.json
│   ├── recommendations.json
│   └── audit-logs.json
└── redis/        # Redis key conventions and patterns
    └── keys.md
```

## Purpose by Folder

| Folder | Purpose | Consumers |
|--------|---------|-----------|
| `api/` | Synchronous REST API contracts | Gateway, Frontend, Consumers |
| `events/` | Async event contracts (Redis Streams) | Gateway, Worker |
| `db/` | Persisted data schemas | Worker, Frontend (via API) |
| `redis/` | Key naming, TTL, patterns | Gateway, Worker |

## Contract-First Workflow

1. **Identify need** — New interface or change to existing one
2. **Create contract PR** — PR touches **only** `contracts/`
3. **Review** — Requires approval from **both other members** (2 approvals minimum)
4. **Merge** — After approval, contract is frozen
5. **Implement** — Implementation PRs follow (can be parallel across members)
6. **Validate** — CI validates schemas, examples, and OpenAPI lint

## Versioning

- **Format**: `name.vN.json` or `name.vN.yaml` (e.g., `usage-event.v1.json`)
- **Breaking changes** → New version (`v2`, `v3`...)
- **Non-breaking** (optional fields) → Same version
- **Deprecation** — Support old version during migration, document timeline

## Breaking Changes

Require **explicit team agreement** before merging:
- Removing fields
- Changing field types
- Changing enum values
- Making optional fields required

## When to Create Contracts

- Before any implementation that crosses component boundaries
- When two or more services need to agree on data shape
- During Phase 0 for all known interfaces
- As new integration points are discovered

## Ownership

- **All three members** own `contracts/`
- CODEOWNERS requires review from all members
- No single member can merge contract changes alone

## CI Validation

The `contracts` job in CI:
1. Compiles all JSON schemas (AJV)
2. Validates all valid examples pass
3. Validates all invalid examples fail
4. Lints OpenAPI specs (Redocly)