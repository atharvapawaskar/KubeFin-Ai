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
│   ├── pricing.v1.json             # Legacy USD pricing contract
│   ├── pricing.v2.json             # Currency-aware pricing contract
│   ├── usage-events.v1.json        # Legacy USD-enriched event document
│   ├── usage-events.v2.json        # Currency-aware event document
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

Phase 3 pricing records use exact provider/model keys and effective intervals. Store source URL and verification timestamp with each rate. The Worker consumes reviewed rates; the contract does not publish or seed provider prices.

Pricing v2 supports ISO 4217 currency codes and identifies its records with `pricingVersion: 2`. Each Worker deployment selects one pricing currency with `PRICING_CURRENCY` (default `INR`); a rate must exist in that currency for the exact provider/model and event time. Costs are stored as `costAmount` plus `costCurrency`. No exchange-rate conversion is implied; rates sourced in another currency need a separately reviewed FX source and policy. Since v2 changes the persisted pricing shape, v1 schemas remain available for legacy data and v2 uses new schema filenames.

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
