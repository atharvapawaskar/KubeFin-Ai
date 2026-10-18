# Control Plane Analytics and Budget API

Member 3's Stage 5 analytics and Stage 6 budget API service. It implements `GET /api/v2/analytics/spend` and the proposed currency-aware `/api/v2/budgets` CRUD API. The budget v2 schema and OpenAPI document are proposals pending cross-member contract review; the existing USD-only budget v1 contract remains unchanged.

## Local setup

Use Node.js 24 and install this package's lockfile:

```sh
npm ci
npm test
npm start
```

Configure the following environment variables before starting:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string for the KubeFin database. |
| `MONGODB_DB` | Optional database name override; otherwise the URI database is used. |
| `CONTROL_PLANE_PORT` | Listener port; defaults to `4000`. |
| `CONTROL_PLANE_HOST` | Listener address; defaults to `0.0.0.0`. |
| `JWT_ISSUER` | Exact expected OIDC issuer. |
| `JWT_AUDIENCE` | Required JWT audience. |
| `JWT_JWKS_URL` | HTTPS JWKS endpoint for signing keys. |
| `JWT_TENANT_CLAIM` | Issuer claim containing one tenant ID or an array of tenant IDs authorized for the principal. |
| `CURSOR_SIGNING_KEY` | At least 32 random bytes used to authenticate opaque pagination cursors. |

Do not set an empty or placeholder authentication value in a deployed environment. Startup fails if the JWT or cursor verification settings are missing or invalid. Generate the cursor key from a secret manager; rotating it intentionally invalidates outstanding cursors.

## Request behavior

- `from` is inclusive and `to` is exclusive. Both must align to UTC hour/day boundaries. Ranges are capped at 744 hourly or 366 daily windows.
- Every selected window must have a published Stage 4 generation. Missing or changing generations fail closed with `503`; the API does not return partial totals.
- The API reads only generations pointed to by `cost_aggregation_windows`. It rechecks generation pointers after reads to detect rebuild/prune races.
- The authenticated principal's configured tenant claim scopes all MongoDB queries. An explicit unauthorized `tenantId` is rejected before reading rollups.
- Currency and priced/unpriced groups remain separate. Cost amounts are serialized as exact base-10 strings; unpriced rows omit `costAmount`.
- `pageSize` (1–100) and an HMAC-authenticated cursor apply to breakdown rows only. Totals and time series cover the full requested range. Cursor tokens are bound to range, filters, and authorized tenant scope.
- A per-process concurrent-request cap returns `429`; deploy an ingress or gateway-wide limit for cluster-wide rate control.

`/healthz` is liveness. `/readyz` pings MongoDB. Fastify request logging redacts authorization and query strings; error responses contain stable codes and do not expose database or token details.

## Budget behavior (Stage 6 proposal)

- Budget limits use positive exact decimal strings with up to 18 integer and 12 fractional digits, plus an explicit three-letter currency code. No FX conversion is performed.
- Tenant identity is derived only from the verified JWT claim. Creating a budget requires a token scoped to exactly one tenant; list and read access are limited to the caller's tenant set.
- Budget list pages use a bounded (1–100) page size and HMAC-signed cursors bound to the authorized tenant set. The same signing key configuration is used for analytics and budget cursors.
- Current UTC daily/monthly spend is aggregated from processed raw usage events and reported with an as-of time. Unpriced or malformed priced records make the spend status `unknown`; spend is informational and can lag Gateway traffic.
- Budget CRUD is isolated to v2 records with a currency field, preserving legacy v1 records. MongoDB enforces one budget per tenant/scope/currency/period.
- The `enforcement` field is configuration only in this service. Gateway hard-limit behavior requires an agreed Redis counter contract and atomic reservation/settlement design; this API does not claim real-time enforcement.

## Identity integration

The service verifies RS256 or ES256 JWTs against an HTTPS JWKS endpoint, checks issuer, audience, expiry and not-before, and derives authorized tenant IDs only from the configured claim. The identity provider must issue that claim with the documented string-or-array shape. Do not use a client-supplied tenant filter as authorization.

## Limits

The analytics implementation has a reviewed contract. Budget v2 remains a cross-member proposal. Live MongoDB aggregation/index behavior, deployed OIDC tenant mapping, Gateway budget enforcement, and dashboard integration need verification in the deployment environment. The local repository does not contain the Frontend application or a MongoDB fixture dataset.
