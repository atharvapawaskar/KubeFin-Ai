import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { createUsageEvent, MAX_USAGE_EVENT_BYTES } from '../src/events/usage-event.js';
import {
  RedisUsageEventPublisher,
  RedisClientLike,
  sanitizeErrorMessage,
} from '../src/events/redis-publisher.js';
import { buildServer, registerSignalHandlers } from '../src/index.js';
import { loadGeminiConfig, loadRateLimitConfig, loadMetricsConfig } from '../src/config.js';
import {
  createGeminiProvider,
  extractTextFromResponse,
  resolveUpstreamModel,
  extractUsageMetadata,
  extractServedModel,
} from '../src/providers/gemini.js';

describe('Gateway Regression Tests', () => {
  const API_KEY = 'test-api-key-regression';
  const TENANT_ID = 'test-tenant-regression';

  describe('1. Usage Event Validation & String Length Limits', () => {
    const validParams = {
      tenantId: 'tenant-1',
      provider: 'gemini',
      model: 'gemini-1.5-flash',
      inputTokens: 100,
      outputTokens: 50,
    };

    it('rejects tenantId exceeding 256 characters', () => {
      expect(() =>
        createUsageEvent({ ...validParams, tenantId: 'a'.repeat(257) })
      ).toThrow(/tenantId exceeds maximum length of 256 characters/);
    });

    it('rejects provider exceeding 128 characters', () => {
      expect(() =>
        createUsageEvent({ ...validParams, provider: 'p'.repeat(129) })
      ).toThrow(/provider exceeds maximum length of 128 characters/);
    });

    it('rejects model exceeding 256 characters', () => {
      expect(() =>
        createUsageEvent({ ...validParams, model: 'm'.repeat(257) })
      ).toThrow(/model exceeds maximum length of 256 characters/);
    });

    it('rejects requestId exceeding 256 characters (no silent truncation)', () => {
      expect(() =>
        createUsageEvent({ ...validParams, requestId: 'r'.repeat(257) })
      ).toThrow(/requestId exceeds maximum length of 256 characters/);
    });

    it('rejects empty or whitespace-only requestId', () => {
      expect(() =>
        createUsageEvent({ ...validParams, requestId: '   ' })
      ).toThrow(/requestId must be a non-empty string if provided/);
    });

    it('rejects teamId exceeding 256 characters (no silent truncation)', () => {
      expect(() =>
        createUsageEvent({ ...validParams, teamId: 't'.repeat(257) })
      ).toThrow(/teamId exceeds maximum length of 256 characters/);
    });

    it('rejects empty or whitespace-only teamId', () => {
      expect(() =>
        createUsageEvent({ ...validParams, teamId: '' })
      ).toThrow(/teamId must be a non-empty string if provided/);
    });

    it('rejects workloadId exceeding 256 characters (no silent truncation)', () => {
      expect(() =>
        createUsageEvent({ ...validParams, workloadId: 'w'.repeat(257) })
      ).toThrow(/workloadId exceeds maximum length of 256 characters/);
    });

    it('rejects empty or whitespace-only workloadId', () => {
      expect(() =>
        createUsageEvent({ ...validParams, workloadId: '   ' })
      ).toThrow(/workloadId must be a non-empty string if provided/);
    });

    it('rejects invalid custom eventId that is not a UUID', () => {
      expect(() =>
        createUsageEvent({ ...validParams, eventId: 'not-a-uuid-12345' })
      ).toThrow(/eventId: "not-a-uuid-12345". Must be a valid UUID string/);
    });

    it('accepts valid custom UUID eventId', () => {
      const customId = '550e8400-e29b-41d4-a716-446655440000';
      const event = createUsageEvent({ ...validParams, eventId: customId });
      expect(event.eventId).toBe(customId);
    });

    it('rejects invalid custom occurredAt timestamps', () => {
      expect(() =>
        createUsageEvent({ ...validParams, occurredAt: '2026-10-18 12:00:00' })
      ).toThrow(/Must be a valid ISO 8601 UTC timestamp ending in Z/);

      expect(() =>
        createUsageEvent({ ...validParams, occurredAt: '2026-10-18T12:00:00+05:30' })
      ).toThrow(/Must be a valid ISO 8601 UTC timestamp ending in Z/);

      expect(() =>
        createUsageEvent({ ...validParams, occurredAt: 'invalid-date' })
      ).toThrow(/Must be a valid ISO 8601 UTC timestamp ending in Z/);
    });

    it('accepts valid custom occurredAt ISO 8601 UTC timestamp ending in Z', () => {
      const customTimestamp = '2026-10-18T12:34:56.789Z';
      const event = createUsageEvent({ ...validParams, occurredAt: customTimestamp });
      expect(event.occurredAt).toBe(customTimestamp);
    });
  });

  describe('2. Attribution Header Validation in Gateway HTTP API', () => {
    let app: any;

    beforeEach(async () => {
      app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: {
            url: 'redis://localhost:6379',
            stream: 'usage-events',
            enabled: false,
            maxRetries: 1,
            retryDelayMs: 0,
          },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: vi.fn().mockResolvedValue({
            id: 'chat-1',
            object: 'chat.completion',
            created: 12345,
            model: 'gemini-1.5-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
          }),
        },
      });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('returns 400 Bad Request when x-team-id header exceeds 256 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-team-id': 't'.repeat(257),
        },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('INVALID_HEADER');
      expect(body.message).toContain('x-team-id');
    });

    it('returns 400 Bad Request when x-workload-id header exceeds 256 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-workload-id': 'w'.repeat(257),
        },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('INVALID_HEADER');
      expect(body.message).toContain('x-workload-id');
    });

    it('returns 400 Bad Request when x-request-id header exceeds 256 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-request-id': 'r'.repeat(257),
        },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('INVALID_HEADER');
      expect(body.message).toContain('x-request-id');
    });

    it('returns 400 Bad Request when x-team-id header is empty string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-team-id': '   ',
        },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('INVALID_HEADER');
    });
  });

  describe('3. 256 KiB Payload Limit Enforcement', () => {
    it('rejects publishing when serialized payload exceeds 256 KiB', async () => {
      const xAddMock = vi.fn();
      const mockClient: RedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        xAdd: xAddMock,
        on: vi.fn(),
      };

      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        client: mockClient,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const event = createUsageEvent({
        tenantId: 'tenant-1',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        inputTokens: 10,
        outputTokens: 10,
      });

      // Artificially attach large string to exceed 256 KiB
      (event as any).oversizedField = 'x'.repeat(MAX_USAGE_EVENT_BYTES + 10);

      const result = await publisher.publish(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum limit of 256 KiB');
      expect(xAddMock).not.toHaveBeenCalled();
    });
  });

  describe('4. Redis Connection Concurrency & Graceful Shutdown', () => {
    it('handles concurrent publish calls safely by deduplicating connection in-flight', async () => {
      let connectCallCount = 0;
      let resolveConnect: () => void;
      const connectPromise = new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

      const mockClient: RedisClientLike = {
        isOpen: false,
        connect: vi.fn().mockImplementation(async () => {
          connectCallCount++;
          await connectPromise;
          mockClient.isOpen = true;
        }),
        xAdd: vi.fn().mockResolvedValue('1000-0'),
        on: vi.fn(),
      };

      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        client: mockClient,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const event = createUsageEvent({
        tenantId: 't1',
        provider: 'gemini',
        model: 'm1',
        inputTokens: 10,
        outputTokens: 10,
      });

      // Launch multiple publishes concurrently while client is disconnected
      const publish1 = publisher.publish(event);
      const publish2 = publisher.publish(event);
      const publish3 = publisher.publish(event);

      // Resolve connect
      resolveConnect!();

      const [res1, res2, res3] = await Promise.all([publish1, publish2, publish3]);

      expect(connectCallCount).toBe(1);
      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res3.success).toBe(true);
      expect(mockClient.xAdd).toHaveBeenCalledTimes(3);
    });

    it('uses quit() rather than disconnect() for graceful shutdown', async () => {
      const quitMock = vi.fn().mockResolvedValue('OK');
      const disconnectMock = vi.fn().mockResolvedValue(undefined);

      const mockClient: RedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        quit: quitMock,
        disconnect: disconnectMock,
        xAdd: vi.fn(),
        on: vi.fn(),
      };

      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        client: mockClient,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await publisher.close();

      expect(quitMock).toHaveBeenCalledTimes(1);
      expect(disconnectMock).not.toHaveBeenCalled();
    });

    it('rejects publishing after close() without attempting connection', async () => {
      const connectMock = vi.fn();
      const mockClient: RedisClientLike = {
        isOpen: false,
        connect: connectMock,
        quit: vi.fn(),
        xAdd: vi.fn(),
        on: vi.fn(),
      };

      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        client: mockClient,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await publisher.close();

      const event = createUsageEvent({
        tenantId: 't1',
        provider: 'gemini',
        model: 'm1',
        inputTokens: 10,
        outputTokens: 10,
      });

      const result = await publisher.publish(event);
      expect(result.success).toBe(false);
      expect(result.error).toContain('closed');
      expect(connectMock).not.toHaveBeenCalled();
    });
  });

  describe('5. Provider Error Message Sanitization', () => {
    it('sanitizes provider error response without exposing raw exception, query params, or secrets', async () => {
      const rawSecret = 'AIzaSyTestApiKeySecret1234567890';
      const rawException = `Upstream call failed at https://generativelanguage.googleapis.com/v1beta/models?key=${rawSecret} with socket error`;

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: {
            url: 'redis://localhost:6379',
            stream: 'usage-events',
            enabled: false,
            maxRetries: 1,
            retryDelayMs: 0,
          },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: vi.fn().mockRejectedValue(new Error(rawException)),
        },
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('PROVIDER_ERROR');
      expect(body.error).toBe('Bad Gateway');

      // Crucial: response must NOT contain raw exception string, URL, or API key
      expect(body.message).not.toContain(rawSecret);
      expect(body.message).not.toContain('generativelanguage.googleapis.com');
      expect(body.message).not.toContain('socket error');
      expect(body.message).toBe(
        'Provider error: The upstream provider encountered an error while processing the request'
      );

      await app.close();
    });
  });

  describe('6. SIGTERM / SIGINT Signal Handling & Graceful Fastify Shutdown', () => {
    it('gracefully closes fastify on SIGTERM without leaking listeners', async () => {
      const app = Fastify({ logger: false });
      let closed = false;
      app.addHook('onClose', async () => {
        closed = true;
      });

      const initialSigtermCount = process.listenerCount('SIGTERM');
      const initialSigintCount = process.listenerCount('SIGINT');

      registerSignalHandlers(app);

      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount + 1);

      // Trigger SIGTERM
      process.emit('SIGTERM');

      // Await close
      await vi.waitFor(() => expect(closed).toBe(true));

      // Handlers must be cleaned up after signal is processed and fastify closes
      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
    });

    it('gracefully closes fastify on SIGINT without leaking listeners', async () => {
      const app = Fastify({ logger: false });
      let closed = false;
      app.addHook('onClose', async () => {
        closed = true;
      });

      const initialSigtermCount = process.listenerCount('SIGTERM');
      const initialSigintCount = process.listenerCount('SIGINT');

      registerSignalHandlers(app);

      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount + 1);

      // Trigger SIGINT
      process.emit('SIGINT');

      // Await close
      await vi.waitFor(() => expect(closed).toBe(true));

      // Handlers must be cleaned up
      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
    });

    it('cleanup unregisters signal listeners when fastify is closed directly', async () => {
      const app = Fastify({ logger: false });

      const initialSigtermCount = process.listenerCount('SIGTERM');
      const initialSigintCount = process.listenerCount('SIGINT');

      registerSignalHandlers(app);

      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount + 1);

      await app.close();

      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
    });
  });

  describe('7. Configurable Provider Timeout & Abort Handling', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('defaults GEMINI_TIMEOUT_MS to 30000 if unspecified', () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key';
      delete process.env.GEMINI_TIMEOUT_MS;
      const config = loadGeminiConfig();
      expect(config.timeoutMs).toBe(30000);
    });

    it('loads and parses valid GEMINI_TIMEOUT_MS values', () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key';

      process.env.GEMINI_TIMEOUT_MS = '15000';
      expect(loadGeminiConfig().timeoutMs).toBe(15000);

      process.env.GEMINI_TIMEOUT_MS = '1';
      expect(loadGeminiConfig().timeoutMs).toBe(1);

      process.env.GEMINI_TIMEOUT_MS = '600000';
      expect(loadGeminiConfig().timeoutMs).toBe(600000);
    });

    it('rejects invalid, non-integer, negative, or out-of-range GEMINI_TIMEOUT_MS', () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key';

      const invalidValues = ['0', '-100', 'abc', '12.5', '600001', '', '   '];
      for (const val of invalidValues) {
        process.env.GEMINI_TIMEOUT_MS = val;
        expect(() => loadGeminiConfig()).toThrow(
          /GEMINI_TIMEOUT_MS must be a positive integer between 1 and 600000 milliseconds/
        );
      }
    });

    it('returns sanitized HTTP 504 PROVIDER_TIMEOUT when upstream provider request aborts or times out', async () => {
      const abortError = new Error(
        '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash?key=AIzaSySecretApiKey: This operation was aborted'
      );

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash', timeoutMs: 5000 },
          redis: {
            url: 'redis://localhost:6379',
            stream: 'usage-events',
            enabled: false,
            maxRetries: 1,
            retryDelayMs: 0,
          },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: vi.fn().mockRejectedValue(abortError),
        },
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test timeout' }] },
      });

      expect(res.statusCode).toBe(504);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('PROVIDER_TIMEOUT');
      expect(body.error).toBe('Gateway Timeout');
      expect(body.message).toBe('Provider timeout: The upstream provider request timed out');

      // Sanitization: Ensure no secrets, URLs, or raw exception strings are exposed
      expect(body.message).not.toContain('AIzaSySecretApiKey');
      expect(body.message).not.toContain('generativelanguage.googleapis.com');
      expect(body.message).not.toContain('aborted');

      await app.close();
    });

    it('native SDK aborts via AbortSignal when timeoutMs expires', async () => {
      // 1ms timeout guarantees immediate client-side abort in fetch
      const provider = createGeminiProvider({
        apiKey: 'test-fake-key',
        defaultModel: 'gemini-1.5-flash',
        timeoutMs: 1,
      });

      await expect(
        provider.createChatCompletion({
          messages: [{ role: 'user', content: 'hello' }],
        })
      ).rejects.toThrow(/aborted/i);
    });
  });

  describe('8. Gateway Rate Limiting Configuration & Regression', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('defaults rate limit config values when unspecified', () => {
      delete process.env.RATE_LIMIT_ENABLED;
      delete process.env.RATE_LIMIT_MAX_REQUESTS;
      delete process.env.RATE_LIMIT_WINDOW_MS;
      delete process.env.RATE_LIMIT_FAILURE_MODE;
      delete process.env.RATE_LIMIT_REDIS_KEY_PREFIX;

      const config = loadRateLimitConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxRequests).toBe(60);
      expect(config.windowMs).toBe(60000);
      expect(config.failureMode).toBe('fail-closed');
      expect(config.redisKeyPrefix).toBe('ratelimit:tenant');
    });

    it('loads valid custom rate limit configuration', () => {
      process.env.RATE_LIMIT_ENABLED = 'false';
      process.env.RATE_LIMIT_MAX_REQUESTS = '120';
      process.env.RATE_LIMIT_WINDOW_MS = '30000';
      process.env.RATE_LIMIT_FAILURE_MODE = 'fail-open';
      process.env.RATE_LIMIT_REDIS_KEY_PREFIX = 'custom:rate:limit';

      const config = loadRateLimitConfig();
      expect(config.enabled).toBe(false);
      expect(config.maxRequests).toBe(120);
      expect(config.windowMs).toBe(30000);
      expect(config.failureMode).toBe('fail-open');
      expect(config.redisKeyPrefix).toBe('custom:rate:limit');
    });

    it('rejects invalid RATE_LIMIT_MAX_REQUESTS', () => {
      const invalid = ['0', '-10', 'abc', '12.5', '10000001', ''];
      for (const val of invalid) {
        process.env.RATE_LIMIT_MAX_REQUESTS = val;
        expect(() => loadRateLimitConfig()).toThrow(/RATE_LIMIT_MAX_REQUESTS must be a positive integer/);
      }
    });

    it('rejects invalid RATE_LIMIT_WINDOW_MS', () => {
      const invalid = ['0', '999', '-100', 'xyz', '86400001'];
      for (const val of invalid) {
        process.env.RATE_LIMIT_WINDOW_MS = val;
        expect(() => loadRateLimitConfig()).toThrow(/RATE_LIMIT_WINDOW_MS must be a positive integer/);
      }
    });

    it('rejects invalid RATE_LIMIT_FAILURE_MODE', () => {
      const invalid = ['fail-silent', 'ignore', 'true', 'false', ''];
      for (const val of invalid) {
        process.env.RATE_LIMIT_FAILURE_MODE = val;
        expect(() => loadRateLimitConfig()).toThrow(/RATE_LIMIT_FAILURE_MODE must be either 'fail-closed' or 'fail-open'/);
      }
    });

    it('rejects empty or oversized RATE_LIMIT_REDIS_KEY_PREFIX', () => {
      process.env.RATE_LIMIT_REDIS_KEY_PREFIX = '';
      expect(() => loadRateLimitConfig()).toThrow(/RATE_LIMIT_REDIS_KEY_PREFIX must be a non-empty string/);

      process.env.RATE_LIMIT_REDIS_KEY_PREFIX = 'a'.repeat(129);
      expect(() => loadRateLimitConfig()).toThrow(/RATE_LIMIT_REDIS_KEY_PREFIX must be a non-empty string/);
    });
  });

  describe('9. Prometheus Metrics Configuration & Regression', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('defaults metrics configuration to enabled=true, authToken=undefined when env vars are unset', () => {
      delete process.env.METRICS_ENABLED;
      delete process.env.METRICS_AUTH_TOKEN;

      const config = loadMetricsConfig();
      expect(config.enabled).toBe(true);
      expect(config.authToken).toBeUndefined();
    });

    it('disables metrics when METRICS_ENABLED is set to "false"', () => {
      process.env.METRICS_ENABLED = 'false';
      delete process.env.METRICS_AUTH_TOKEN;

      const config = loadMetricsConfig();
      expect(config.enabled).toBe(false);
      expect(config.authToken).toBeUndefined();
    });

    it('loads valid custom METRICS_AUTH_TOKEN', () => {
      process.env.METRICS_ENABLED = 'true';
      process.env.METRICS_AUTH_TOKEN = 'secret-prom-token-123';

      const config = loadMetricsConfig();
      expect(config.enabled).toBe(true);
      expect(config.authToken).toBe('secret-prom-token-123');
    });

    it('rejects empty or whitespace-only METRICS_AUTH_TOKEN', () => {
      const invalid = ['', '   ', '\t\n'];
      for (const val of invalid) {
        process.env.METRICS_AUTH_TOKEN = val;
        expect(() => loadMetricsConfig()).toThrow(
          /METRICS_AUTH_TOKEN must be a non-empty string if provided/
        );
      }
    });
  });

  describe('10. Gemini Provider Response Parsing, Safety Blocks & Model Resolution', () => {
    describe('resolveUpstreamModel', () => {
      it('preserves gemini-3.5-flash without redirecting to gemini-1.5-flash', () => {
        expect(resolveUpstreamModel('gemini-3.5-flash')).toBe('gemini-3.5-flash');
        expect(resolveUpstreamModel('  gemini-3.5-flash  ')).toBe('gemini-3.5-flash');
      });

      it('preserves configured and requested models unchanged without inventing fallback model names', () => {
        expect(resolveUpstreamModel('gemini-3.5-flash')).toBe('gemini-3.5-flash');
        expect(resolveUpstreamModel('gemini-1.5-flash')).toBe('gemini-1.5-flash');
        expect(resolveUpstreamModel('gemini-1.5-pro')).toBe('gemini-1.5-pro');
        expect(resolveUpstreamModel('gemini-2.0-flash')).toBe('gemini-2.0-flash');
        expect(resolveUpstreamModel('gemini-1.0-pro')).toBe('gemini-1.0-pro');
      });
    });

    describe('extractTextFromResponse', () => {
      it('maps prompt-level blockReason to content_filter with empty text', () => {
        const response = {
          promptFeedback: {
            blockReason: 'SAFETY',
            safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH' }],
          },
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('content_filter');
        expect(result.text).toBe('');
      });

      it('maps prompt-level OTHER blockReason to content_filter', () => {
        const response = {
          promptFeedback: {
            blockReason: 'OTHER',
            blockReasonMessage: 'Blocked due to policy',
          },
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('content_filter');
        expect(result.text).toBe('');
      });

      it('maps candidate-level SAFETY finishReason to content_filter', () => {
        const response = {
          candidates: [{
            finishReason: 'SAFETY',
            content: { parts: [] },
          }],
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('content_filter');
        expect(result.text).toBe('');
      });

      it('maps candidate-level RECITATION finishReason to content_filter', () => {
        const response = {
          candidates: [{
            finishReason: 'RECITATION',
            content: { parts: [{ text: 'partial copyright recitation' }] },
          }],
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('content_filter');
        expect(result.text).toBe('partial copyright recitation');
      });

      it('maps candidate-level BLOCKLIST, PROHIBITED_CONTENT, SPII, MALICIOUS to content_filter', () => {
        const reasons = ['BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALICIOUS', 'LANGUAGE'];
        for (const reason of reasons) {
          const response = {
            candidates: [{
              finishReason: reason,
              content: { parts: [] },
            }],
          };

          const result = extractTextFromResponse(response);
          expect(result.finishReason).toBe('content_filter');
        }
      });

      it('maps MAX_TOKENS finishReason to length and preserves generated text', () => {
        const response = {
          candidates: [{
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: 'This response was cut off because of' }] },
          }],
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('length');
        expect(result.text).toBe('This response was cut off because of');
      });

      it('maps STOP finishReason to stop and concatenates multiple content parts', () => {
        const response = {
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'Hello, ' },
                { text: 'how can I assist ' },
                { text: 'you today?' },
              ],
            },
          }],
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('stop');
        expect(result.text).toBe('Hello, how can I assist you today?');
      });

      it('maps STOP with empty text to empty_response', () => {
        const response = {
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [] },
          }],
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('empty_response');
        expect(result.text).toBe('');
      });

      it('returns empty_response when candidates array is empty and no promptFeedback', () => {
        const response = {
          candidates: [],
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('empty_response');
        expect(result.text).toBe('');
      });

      it('returns empty_response for null, undefined, or empty object response', () => {
        expect(extractTextFromResponse(null).finishReason).toBe('empty_response');
        expect(extractTextFromResponse(undefined).finishReason).toBe('empty_response');
        expect(extractTextFromResponse({}).finishReason).toBe('empty_response');
      });

      it('safely handles response where response.text() throws', () => {
        const response = {
          candidates: [{
            finishReason: 'SAFETY',
            content: { parts: [] },
          }],
          text: () => {
            throw new Error('GoogleGenerativeAIResponseError: Candidate was blocked due to SAFETY');
          },
        };

        const result = extractTextFromResponse(response);
        expect(result.finishReason).toBe('content_filter');
        expect(result.text).toBe('');
      });
    });

    describe('createGeminiProvider request validation', () => {
      it('rejects requests containing only system messages', async () => {
        const provider = createGeminiProvider({
          apiKey: 'fake-key',
          defaultModel: 'gemini-1.5-flash',
        });

        await expect(
          provider.createChatCompletion({
            messages: [{ role: 'system', content: 'You are an assistant' }],
          })
        ).rejects.toThrow(/At least one non-system message is required/);
      });
    });
  });
});
