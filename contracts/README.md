# Contracts — Shared Source of Truth

This directory contains all shared interfaces between components. **Contracts are the integration boundary** — no component should depend on another's implementation details.

## Directory Structure

```
contracts/
├── api/          # OpenAPI specifications
│   ├── gateway-api.yaml           # Consumer → Gateway (OpenAI-compatible)
│   └── control-plane-api.yaml     # Frontend → Control Plane API
├── events/       # JSON Schemas for async events
│   └── usage-event.v1.json        # Gateway → Worker (Redis Streams)
├── db/           # MongoDB collection schemas (JSON Schema)
│   ├── usage-events.v1.json       # Raw usage and legacy USD-enriched events
│   ├── usage-events.v2.json       # Currency-aware usage events
│   ├── pricing.v1.json            # Legacy USD pricing contract
│   ├── pricing.v2.json            # Currency-aware pricing contract
│   ├── cost-aggregations.v1.json  # Proposed hourly/daily currency-separated rollups
│   └── cost-aggregation-windows.v1.json # Proposed generation publication and lease state
└── redis/        # Redis key conventions and patterns
    └── keys.md
```

## Purpose by Folder

| Folder | Purpose | Consumers |
|--------|---------|-----------|
| `api/` | Synchronous REST API contracts | Gateway, Frontend, Consumers |
| `events/` | Async events | Gateway, Worker |
| `db/` | Persisted data schemas | Worker, Frontend (via API) |
| `redis/` | Redis key naming and patterns | Gateway, Worker |

## Contract-First Workflow

1. **Identify need** — New interface or change to an existing one
2. **Create contract PR** — PR touches **only** `contracts/`
3. **Review** — Requires approval from **both other members** (2 approvals minimum)
4. **Merge** — After approval, the contract is frozen
5. **Implement** — Implementation PRs follow
6. **Validate** — CI validates schemas, examples, and OpenAPI lint

## Versioning

- **Format**: `name.vN.json` or `name.vN.yaml` (e.g., `usage-event.v1.json`)
- **Breaking changes** → New version (`v2`, `v3`...)
- **Non-breaking** (optional fields) → Same version
- **Deprecation** — Support old versions during a documented migration.

Phase 3 pricing v2 supports ISO 4217 currency codes. Each Worker deployment selects one pricing currency with `PRICING_CURRENCY` (default `INR`); there is no implicit FX conversion.

Stage 4 rollup proposals use UTC half-open windows and preserve tenant/team/workload/provider/model dimensions. Priced totals are separated by currency. Unpriced events form a separate group with a null currency and no cost amount. Rollups are rebuilt as generation snapshots; readers select only the generation published by the corresponding window-state record. The proposal does not set TTL or retention policy.

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
