# Control Plane Analytics API

Member 3's Stage 5 API service. It implements the reviewed contract at `GET /api/v2/analytics/spend` and keeps the existing USD-only v1 contract unchanged.

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

## Identity integration

The service verifies RS256 or ES256 JWTs against an HTTPS JWKS endpoint, checks issuer, audience, expiry and not-before, and derives authorized tenant IDs only from the configured claim. The identity provider must issue that claim with the documented string-or-array shape. Do not use a client-supplied tenant filter as authorization.

## Limits

The service and API contract are implemented and unit tested. Live MongoDB aggregation, index creation, OIDC-provider integration, and dashboard integration need verification in the deployment environment. The local repository does not contain the Frontend application or a MongoDB fixture dataset.
