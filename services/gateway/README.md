# Gateway Service

Minimal Fastify + TypeScript Gateway foundation for Kubefin with API key authentication.

## Prerequisites

- Node.js 18+
- npm

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file and configure:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Server configuration
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Authentication
API_KEY=your-secure-api-key-here  # Generate with: openssl rand -hex 32
TENANT_ID=default-tenant
```

**Security Note**: Never commit the `.env` file or expose the API key in logs or source code.

## Configuration (Extended)

For AI provider integration, also configure:

```bash
# Google Gemini Provider
# Get your API key from: https://makersuite.google.com/app/apikey
GEMINI_API_KEY=your-gemini-api-key-here
# Model options: gemini-1.5-flash, gemini-1.5-pro, gemini-1.0-pro
GEMINI_MODEL=gemini-1.5-flash
```

## Development

Start the development server with hot reload:

```bash
npm run dev
```

The gateway will start on `http://localhost:3000` by default.

## Building

Build TypeScript to JavaScript:

```bash
npm run build
```

## Production

Run the compiled JavaScript:

```bash
npm start
```

## Testing

Run the authentication tests:

```bash
npm test
```

## API Documentation

### Public Endpoints

#### Health Check

```bash
GET /health
```

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-10-08T21:03:08.700Z",
  "service": "gateway",
  "version": "0.1.0"
}
```

#### Prometheus Metrics

```bash
GET /metrics
```

Returns Prometheus exposition format metrics (`text/plain; version=0.0.4; charset=utf-8`).

**Security and Access Control Decision:**
- `/metrics` is intended for internal Kubernetes cluster scraping (e.g., Prometheus / kube-prometheus-stack).
- It bypasses tenant Bearer authentication and tenant rate limiting so scrapers are not blocked or counted against tenant quotas.
- Zero sensitive information or high-cardinality data is exported: labels are strictly bounded to operational dimensions (`method`, `route`, `status`, `provider`, `model`). Tenant IDs, API keys, request IDs, prompts, and completions are never used as labels.
- For public ingress, access to `/metrics` should be restricted at the ingress level. Optionally, an internal authorization token can be enforced via `METRICS_AUTH_TOKEN`.

### Protected Endpoints

All endpoints except `/health` and `/metrics` require authentication.

**Authentication Header:**
```
Authorization: Bearer <API_KEY>
```

#### Test Authentication

```bash
GET /v1/test-auth
```

Returns authenticated tenant information.

**Response (authenticated):**
```json
{
  "message": "Authenticated successfully",
  "tenantId": "default-tenant",
  "apiKeyPrefix": "abc12345"
}
```

**Error Responses:**

- **401 Unauthorized - Missing header:**
```json
{
  "error": "Unauthorized",
  "message": "Missing Authorization header",
  "code": "MISSING_AUTH_HEADER"
}
```

- **401 Unauthorized - Invalid format:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid Authorization header format. Expected: Bearer <API_KEY>",
  "code": "INVALID_AUTH_FORMAT"
}
```

- **401 Unauthorized - Invalid key:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid API key",
  "code": "INVALID_API_KEY"
}
```

#### Chat Completions (OpenAI Compatible)

```bash
POST /v1/chat/completions
```

Requires authentication. Forwards requests to Google Gemini and returns OpenAI-compatible response format.

**Request Body:**
```json
{
  "model": "gemini-1.5-flash",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello, how are you?"}
  ],
  "temperature": 0.7,
  "max_tokens": 2048
}
```

**Response (success):**
```json
{
  "id": "chatcmpl-1234567890-abcdef",
  "object": "chat.completion",
  "created": 1699900000,
  "model": "gemini-1.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! I'm doing well, thank you for asking. How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 18,
    "total_tokens": 43
  }
}
```

**Error Responses:**

- **400 Bad Request - Invalid request:**
```json
{
  "error": "Bad Request",
  "message": "messages array is required and must not be empty",
  "code": "INVALID_REQUEST"
}
```

- **400 Bad Request - Maximum tokens ceiling exceeded:**
```json
{
  "error": "Bad Request",
  "message": "Requested max_tokens (5000) exceeds maximum permitted limit of 4096",
  "code": "MAX_TOKENS_EXCEEDED"
}
```

- **401 Unauthorized** (same as above - missing/invalid API key)

- **403 Forbidden - Model not allowed by policy:**
```json
{
  "error": "Forbidden",
  "message": "Model 'unauthorized-model' is not allowed",
  "code": "MODEL_NOT_ALLOWED"
}
```

- **400 Bad Request - Malformed JSON or prototype poisoning:**
```json
{
  "error": "Bad Request",
  "message": "Invalid or malformed JSON payload",
  "code": "INVALID_JSON"
}
```

- **400 Bad Request - Excessive JSON nesting depth:**
```json
{
  "error": "Bad Request",
  "message": "Request payload exceeds maximum allowed nesting depth of 32",
  "code": "EXCESSIVE_NESTING"
}
```

- **413 Payload Too Large - Request body exceeds size limit:**
```json
{
  "error": "Payload Too Large",
  "message": "Request body exceeds maximum permitted size of 1048576 bytes",
  "code": "PAYLOAD_TOO_LARGE"
}
```

- **429 Too Many Requests - Provider rate limit:**
```json
{
  "error": "Too Many Requests",
  "message": "Provider rate limit exceeded. Please try again later.",
  "code": "PROVIDER_RATE_LIMIT"
}
```

- **502 Bad Gateway - Provider error:**
```json
{
  "error": "Bad Gateway",
  "message": "Provider error: ...",
  "code": "PROVIDER_ERROR"
}
```

- **501 Not Implemented - Streaming:**
```json
{
  "error": "Not Implemented",
  "message": "Streaming is not supported yet",
  "code": "STREAMING_NOT_SUPPORTED"
}
```

## Manual Testing

### Test public health endpoint:
```bash
curl http://localhost:3000/health
```

### Test protected endpoint without auth (should fail):
```bash
curl http://localhost:3000/v1/test-auth
```

### Test protected endpoint with valid API key:
```bash
curl -H "Authorization: Bearer your-api-key-here" \
  http://localhost:3000/v1/test-auth
```

### Test protected endpoint with invalid API key (should fail):
```bash
curl -H "Authorization: Bearer wrong-key" \
  http://localhost:3000/v1/test-auth
```

### Test chat completions endpoint:
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Say hello in one sentence"}
    ],
    "temperature": 0.7
  }'
```

## Project Structure

```
services/gateway/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── config.ts             # Environment configuration
│   ├── types.ts              # TypeScript type definitions
│   ├── middleware/
│   │   └── auth.ts           # API key authentication middleware
│   └── providers/
│       └── gemini.ts         # Google Gemini provider integration
├── tests/
│   ├── auth.test.ts          # Authentication tests
│   └── chat.test.ts          # Chat completions tests
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── .env.example              # Example environment variables
├── .npmrc                    # npm registry configuration
└── README.md                 # This file
```

## Architecture

### Request Flow

```
Client Request
    ↓
Fastify Server
    ↓
Auth Middleware (onRequest hook)
    ↓
Skip if path is /health
    ↓
Extract Authorization header
    ↓
Validate Bearer <API_KEY> format
    ↓
Compare with configured API_KEY
    ↓
Resolve tenant identity
    ↓
Attach request.user = { tenantId, apiKeyPrefix }
    ↓
Continue to route handler
```

### Security Features

- **API Key Protection**: Stored in environment variables, logged with 8-character prefix only, never fully exposed
- **Provider Credential Redaction**: Upstream provider API keys (Gemini) sanitized from all client responses and error logs
- **Payload Size Ceiling**: Configurable `GATEWAY_MAX_PAYLOAD_BYTES` (default: 1 MiB / 1048576 bytes) returning HTTP 413 `PAYLOAD_TOO_LARGE`
- **Prototype & Constructor Poisoning Protection**: Fastify `secure-json-parse` rejects `__proto__` and `constructor.prototype` keys with HTTP 400 `INVALID_JSON`
- **JSON Nesting Depth Limits**: Recursion capped at 32 levels, rejecting excessive nesting with HTTP 400 `EXCESSIVE_NESTING`
- **Header Injection Defense**: Rejects CRLF characters (`\r`, `\n`), null bytes, and non-printable control characters in `x-request-id`, `x-team-id`, `x-workload-id`
- **Parameter Bounds Validation**: Enforces positive integers for `max_tokens` (>= 1) and valid range `[0, 2]` for `temperature` before provider dispatch
- **Public Endpoint Isolation**: Public `/health` and `/metrics` bypass auth and policy middleware safely

### Reliability & Resilience (Circuit Breaker & Upstream Retry)

The Gateway features enterprise-grade resilience against upstream AI provider outages and transient network hiccups:

- **Circuit Breaker State Machine**:
  - `CLOSED`: Normal operation. Tracks consecutive eligible upstream failures. If consecutive failures reach `CIRCUIT_BREAKER_FAILURE_THRESHOLD` (default: 5), the circuit trips to `OPEN`.
  - `OPEN`: Fast-fails incoming `/v1/chat/completions` requests immediately with HTTP 503 `CIRCUIT_BREAKER_OPEN`, preserving Gateway compute capacity and preventing thread pool exhaustion during provider outages.
  - `HALF_OPEN`: After `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` (default: 30000ms), transitions to `HALF_OPEN` and permits a limited number of probe requests (`CIRCUIT_BREAKER_HALF_OPEN_PROBES`, default: 1).
    - If the probe succeeds, the circuit fully recovers and transitions back to `CLOSED`.
    - If the probe fails, the circuit immediately trips back to `OPEN` for another cooldown interval.
    - Concurrent requests arriving while probes are saturated are fast-failed with HTTP 503 `CIRCUIT_BREAKER_OPEN`.

- **Bounded Upstream Retry**:
  - Automatically retries transient errors (`HTTP 503 Service Unavailable`, `HTTP 429 Rate Limit / Quota Exceeded`, `HTTP 502 Bad Gateway`, `HTTP 500 Internal Error`).
  - Uses exponential backoff with bounded randomized jitter:
    $$\text{delay} = \min(\text{maxDelayMs}, \text{baseDelayMs} \times 2^{\text{attempt}-1}) \times (0.5 + 0.5 \times \text{random})$$
  - Defaults: `UPSTREAM_MAX_RETRIES=2` (max 3 total attempts), `UPSTREAM_RETRY_BASE_DELAY_MS=200`, `UPSTREAM_RETRY_MAX_DELAY_MS=2000`.
  - **Conservative Timeout & Billing Safety**: Upstream timeouts (`PROVIDER_TIMEOUT`, `AbortError`, socket timeouts) and connection resets are **never retried**. Google Gemini does not support request deduplication / idempotency headers; retrying an in-flight prompt could result in double-billing the tenant.
  - **Usage Event Idempotency**: Exactly one usage event is emitted for a successful logical request upon retry success; zero usage events are emitted on fast-failed circuit breaker rejections.

### Chat Completions Request Flow

```
Client (SupportBot)
    ↓ POST /v1/chat/completions + Authorization: Bearer <KUBEFIN_API_KEY>
Fastify Server
    ↓
Auth Middleware (onRequest hook)
    ↓
Validate Kubefin API key & resolve tenant
    ↓
Payload & JSON Security (preValidation hook)
    ↓
Rate Limiting & Policy Engine (preHandler hook)
    ↓
Circuit Breaker Permit Check (CLOSED / OPEN / HALF_OPEN)
    ├─ If OPEN or probe saturated → Fast-fail HTTP 503 CIRCUIT_BREAKER_OPEN
    └─ If CLOSED or probe permitted → Proceed to upstream dispatch
           ↓
Upstream Provider Dispatch with Bounded Exponential Retry (503/429/502)
    ├─ If transient error → Retry with exponential backoff & jitter
    ├─ If timeout/permanent → Terminate immediately without duplicate billing
    └─ On final outcome:
           ├─ Success → Record circuit breaker success & emit 1 Redis usage event
           └─ Failure → Record circuit breaker failure & return mapped 5xx/4xx
```

## Future Enhancements

This minimal implementation can be replaced with:
- Database-backed API key management
- JWT tokens
- OAuth 2.0
- Role-based access control (RBAC)
- API key rotation
- Rate limiting per tenant