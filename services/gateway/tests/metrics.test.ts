import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  Counter,
  Histogram,
  MetricsRegistry,
  normalizeRoute,
  formatMetricLine,
} from '../src/metrics.js';
import { buildServer } from '../src/index.js';
import { MemoryRateLimiter } from '../src/middleware/rate-limit.js';

describe('Prometheus Metrics System', () => {
  const API_KEY = 'test-api-key-metrics';
  const TENANT_ID = 'test-tenant-metrics';

  describe('1. Metric Types Unit Tests', () => {
    it('Counter increments with and without labels', () => {
      const counter = new Counter('test_counter_total', 'A test counter');

      expect(counter.get()).toBe(0);
      counter.inc();
      expect(counter.get()).toBe(1);
      counter.inc({}, 4);
      expect(counter.get()).toBe(5);

      counter.inc({ method: 'GET', status: '200' }, 2);
      expect(counter.get({ method: 'GET', status: '200' })).toBe(2);

      // Throws on negative
      expect(() => counter.inc({}, -1)).toThrow(/cannot be incremented by negative/);
    });

    it('Counter formats valid Prometheus exposition lines', () => {
      const counter = new Counter('test_requests_total', 'Total requests');
      counter.inc({ method: 'POST', route: '/v1/chat/completions' }, 3);

      const text = counter.toPrometheusText();
      expect(text).toContain('# HELP test_requests_total Total requests');
      expect(text).toContain('# TYPE test_requests_total counter');
      expect(text).toContain('test_requests_total{method="POST",route="/v1/chat/completions"} 3');
    });

    it('Histogram observes values and produces correct bucket counts, sum, and count', () => {
      const histogram = new Histogram({
        name: 'test_duration_seconds',
        help: 'Duration in seconds',
        buckets: [0.1, 0.5, 1.0],
      });

      histogram.observe({ route: '/health' }, 0.05);
      histogram.observe({ route: '/health' }, 0.3);
      histogram.observe({ route: '/health' }, 1.5);

      const stats = histogram.get({ route: '/health' });
      expect(stats?.count).toBe(3);
      expect(stats?.sum).toBeCloseTo(1.85, 2);

      const text = histogram.toPrometheusText();
      expect(text).toContain('test_duration_seconds_bucket{le="0.1",route="/health"} 1');
      expect(text).toContain('test_duration_seconds_bucket{le="0.5",route="/health"} 2');
      expect(text).toContain('test_duration_seconds_bucket{le="1",route="/health"} 2');
      expect(text).toContain('test_duration_seconds_bucket{le="+Inf",route="/health"} 3');
      expect(text).toContain('test_duration_seconds_count{route="/health"} 3');
      expect(text).toContain('test_duration_seconds_sum{route="/health"} 1.85');
    });

    it('normalizeRoute prevents route cardinality explosion', () => {
      expect(normalizeRoute({ routeOptions: { url: '/v1/chat/completions' } } as any)).toBe(
        '/v1/chat/completions'
      );
      expect(normalizeRoute({ routeOptions: { url: '/*' } } as any)).toBe('unmatched');
      expect(normalizeRoute({} as any)).toBe('unmatched');
    });

    it('formatMetricLine escapes special characters properly', () => {
      const line = formatMetricLine('metric', { desc: 'line1\nline2', quote: 'a"b' }, 1);
      expect(line).toBe('metric{desc="line1\\nline2",quote="a\\"b"} 1');
    });
  });

  describe('2. GET /metrics Endpoint & Access Control', () => {
    it('returns 200 with Prometheus exposition content-type when unauthenticated access is allowed', async () => {
      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: true },
        },
      });

      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain; version=0.0.4');

      const body = res.payload;
      expect(body).toContain('# HELP gateway_http_requests_total');
      expect(body).toContain('# TYPE gateway_http_requests_total counter');
      expect(body).toContain('# HELP gateway_http_request_duration_seconds');
      expect(body).toContain('# TYPE gateway_http_request_duration_seconds histogram');
      expect(body).toContain('# HELP gateway_provider_requests_total');
      expect(body).toContain('# HELP gateway_provider_errors_total');
      expect(body).toContain('# HELP gateway_rate_limit_rejections_total');

      await app.close();
    });

    it('enforces internal authorization when METRICS_AUTH_TOKEN is configured', async () => {
      const metricsToken = 'internal-scraper-secret-token';
      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: true, authToken: metricsToken },
        },
      });

      await app.ready();

      // Missing token -> 401
      const resMissing = await app.inject({ method: 'GET', url: '/metrics' });
      expect(resMissing.statusCode).toBe(401);
      const bodyMissing = JSON.parse(resMissing.payload);
      expect(bodyMissing.code).toBe('UNAUTHORIZED_METRICS_ACCESS');

      // Invalid token -> 401
      const resInvalid = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(resInvalid.statusCode).toBe(401);

      // Valid token -> 200
      const resValid = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${metricsToken}` },
      });
      expect(resValid.statusCode).toBe(200);
      expect(resValid.payload).toContain('gateway_http_requests_total');

      await app.close();
    });

    it('returns 404 when metrics are disabled', async () => {
      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: false },
        },
      });

      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('METRICS_DISABLED');

      await app.close();
    });
  });

  describe('3. Metrics Recording During Request Lifecycle', () => {
    it('records HTTP request counts, routes, status codes, and latency observations', async () => {
      const registry = new MetricsRegistry();

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: true },
        },
        metricsRegistry: registry,
      });

      await app.ready();

      // Hit /health (200)
      await app.inject({ method: 'GET', url: '/health' });
      // Hit /v1/test-auth with auth (200)
      await app.inject({
        method: 'GET',
        url: '/v1/test-auth',
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      // Hit /v1/test-auth without auth (401)
      await app.inject({ method: 'GET', url: '/v1/test-auth' });
      // Hit random 404 with auth (normalized to 'unmatched')
      await app.inject({
        method: 'GET',
        url: '/non-existent-endpoint-random123',
        headers: { authorization: `Bearer ${API_KEY}` },
      });

      // Verify HTTP counts
      expect(registry.httpRequestsTotal.get({ method: 'GET', route: '/health', status: '200' })).toBe(1);
      expect(
        registry.httpRequestsTotal.get({ method: 'GET', route: '/v1/test-auth', status: '200' })
      ).toBe(1);
      expect(
        registry.httpRequestsTotal.get({ method: 'GET', route: '/v1/test-auth', status: '401' })
      ).toBe(1);
      expect(registry.httpRequestsTotal.get({ method: 'GET', route: 'unmatched', status: '404' })).toBe(
        1
      );

      // Verify latency observations recorded
      const healthLatency = registry.httpRequestDurationSeconds.get({
        method: 'GET',
        route: '/health',
        status: '200',
      });
      expect(healthLatency).toBeDefined();
      expect(healthLatency!.count).toBe(1);
      expect(healthLatency!.sum).toBeGreaterThanOrEqual(0);

      await app.close();
    });

    it('records provider requests, timeouts, and errors', async () => {
      const registry = new MetricsRegistry();
      const mockCreateCompletion = vi.fn();

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: true },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
        metricsRegistry: registry,
      });

      await app.ready();

      // 1. Success call
      mockCreateCompletion.mockResolvedValueOnce({
        id: 'chat-1',
        object: 'chat.completion',
        created: 1000,
        model: 'gemini-1.5-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      });
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(
        registry.providerRequestsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          status: 'success',
        })
      ).toBe(1);

      // 2. Timeout call
      mockCreateCompletion.mockRejectedValueOnce(new Error('This operation was aborted'));
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(
        registry.providerRequestsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          status: 'timeout',
        })
      ).toBe(1);
      expect(
        registry.providerErrorsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          type: 'timeout',
        })
      ).toBe(1);

      // 3. Rate limit call (upstream 429)
      mockCreateCompletion.mockRejectedValueOnce(new Error('429 rate limit exceeded'));
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(
        registry.providerRequestsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          status: 'rate_limit',
        })
      ).toBe(1);
      expect(
        registry.providerErrorsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          type: 'rate_limit',
        })
      ).toBe(1);

      // 4. Auth error call (upstream 401)
      mockCreateCompletion.mockRejectedValueOnce(new Error('401 invalid api key'));
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(
        registry.providerRequestsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          status: 'auth_error',
        })
      ).toBe(1);
      expect(
        registry.providerErrorsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          type: 'auth_error',
        })
      ).toBe(1);

      // 5. Generic provider error call (500)
      mockCreateCompletion.mockRejectedValueOnce(new Error('Socket disconnected'));
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(
        registry.providerRequestsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          status: 'error',
        })
      ).toBe(1);
      expect(
        registry.providerErrorsTotal.get({
          provider: 'gemini',
          model: 'gemini-1.5-flash',
          type: 'provider_error',
        })
      ).toBe(1);

      await app.close();
    });

    it('records Gateway rate limit rejections', async () => {
      const registry = new MetricsRegistry();
      const limiter = new MemoryRateLimiter({ maxRequests: 1, windowMs: 60000 });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: true },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: vi.fn().mockResolvedValue({
            id: 'chat-1',
            object: 'chat.completion',
            created: 1000,
            model: 'gemini-1.5-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
        },
        rateLimiter: limiter,
        metricsRegistry: registry,
      });

      await app.ready();

      // Hit 1: 200
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'hello' }] },
      });
      expect(res1.statusCode).toBe(200);
      expect(registry.rateLimitRejectionsTotal.get({ route: '/v1/chat/completions' })).toBe(0);

      // Hit 2: 429
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'hello again' }] },
      });
      expect(res2.statusCode).toBe(429);
      expect(registry.rateLimitRejectionsTotal.get({ route: '/v1/chat/completions' })).toBe(1);

      await app.close();
    });
  });

  describe('4. Sensitive Data Safety & Low-Cardinality Enforcement', () => {
    it('strictly ensures no secrets, tenant IDs, prompts, or request IDs leak into metric output', async () => {
      const sensitiveTenantId = 'tenant-customer-super-secret-confidential-999';
      const sensitiveApiKey = 'AIzaSyVerySecretCustomerApiKey12345';
      const sensitivePrompt = 'Super secret classified confidential user prompt!';
      const sensitiveRequestId = 'req-secret-uuid-8888-9999';

      const registry = new MetricsRegistry();

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: sensitiveApiKey, tenantId: sensitiveTenantId },
          gemini: { apiKey: 'dummy', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
          metrics: { enabled: true },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: vi.fn().mockResolvedValue({
            id: 'chat-1',
            object: 'chat.completion',
            created: 1000,
            model: 'gemini-1.5-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'reply' }, finish_reason: 'stop' }],
          }),
        },
        metricsRegistry: registry,
      });

      await app.ready();

      // Send request with sensitive prompt, API key, and custom request ID
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${sensitiveApiKey}`,
          'x-request-id': sensitiveRequestId,
        },
        payload: {
          messages: [{ role: 'user', content: sensitivePrompt }],
        },
      });
      expect(res.statusCode).toBe(200);

      // Scrape /metrics
      const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metricsRes.statusCode).toBe(200);
      const output = metricsRes.payload;

      // Verify that NO sensitive or high-cardinality values exist in /metrics output
      expect(output).not.toContain(sensitiveTenantId);
      expect(output).not.toContain(sensitiveApiKey);
      expect(output).not.toContain(sensitivePrompt);
      expect(output).not.toContain(sensitiveRequestId);

      // Verify only safe, low-cardinality labels exist
      expect(output).toContain('method="POST"');
      expect(output).toContain('route="/v1/chat/completions"');
      expect(output).toContain('status="200"');
      expect(output).toContain('provider="gemini"');
      expect(output).toContain('model="gemini-1.5-flash"');

      await app.close();
    });
  });
});
