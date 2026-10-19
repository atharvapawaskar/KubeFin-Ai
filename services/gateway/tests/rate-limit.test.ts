import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  MemoryRateLimiter,
  RedisRateLimiter,
  RateLimitRedisClientLike,
  RateLimiterStoreError,
  createRateLimitMiddleware,
} from '../src/middleware/rate-limit.js';
import { buildServer } from '../src/index.js';
import { createAuthMiddleware } from '../src/middleware/auth.js';

describe('Gateway Rate Limiting System', () => {
  const API_KEY = 'test-api-key-rate-limit';
  const TENANT_ID = 'test-tenant-rate-limit';

  describe('1. MemoryRateLimiter Unit Tests', () => {
    it('allows requests within maxRequests and decrements remaining', async () => {
      const limiter = new MemoryRateLimiter({ maxRequests: 3, windowMs: 60000 });

      const res1 = await limiter.check('tenant-1');
      expect(res1.allowed).toBe(true);
      expect(res1.limit).toBe(3);
      expect(res1.remaining).toBe(2);

      const res2 = await limiter.check('tenant-1');
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(1);

      const res3 = await limiter.check('tenant-1');
      expect(res3.allowed).toBe(true);
      expect(res3.remaining).toBe(0);

      // 4th request exceeds limit
      const res4 = await limiter.check('tenant-1');
      expect(res4.allowed).toBe(false);
      expect(res4.remaining).toBe(0);
      expect(res4.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('isolates rate limits by tenant key', async () => {
      const limiter = new MemoryRateLimiter({ maxRequests: 2, windowMs: 60000 });

      // Exhaust tenant-1
      await limiter.check('tenant-1');
      await limiter.check('tenant-1');
      const t1Blocked = await limiter.check('tenant-1');
      expect(t1Blocked.allowed).toBe(false);

      // tenant-2 must have fresh quota
      const t2Res = await limiter.check('tenant-2');
      expect(t2Res.allowed).toBe(true);
      expect(t2Res.remaining).toBe(1);
    });

    it('resets counter after windowMs elapses', async () => {
      const limiter = new MemoryRateLimiter({ maxRequests: 1, windowMs: 100 });

      const res1 = await limiter.check('tenant-1');
      expect(res1.allowed).toBe(true);

      const res2 = await limiter.check('tenant-1');
      expect(res2.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 120));

      const res3 = await limiter.check('tenant-1');
      expect(res3.allowed).toBe(true);
      expect(res3.remaining).toBe(0);
    });
  });

  describe('2. RedisRateLimiter Unit Tests (Mock Client)', () => {
    it('executes atomic Lua script via client.eval when available', async () => {
      const evalMock = vi.fn().mockResolvedValue(1);
      const mockClient: RateLimitRedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        incr: vi.fn(),
        pExpire: vi.fn(),
        eval: evalMock,
      };

      const limiter = new RedisRateLimiter({
        url: 'redis://localhost:6379',
        maxRequests: 5,
        windowMs: 60000,
        prefix: 'ratelimit:test',
        client: mockClient,
      });

      const res = await limiter.check('tenant-alpha');
      expect(evalMock).toHaveBeenCalledTimes(1);
      const [script, opts] = evalMock.mock.calls[0];
      expect(script).toContain('INCR');
      expect(script).toContain('PEXPIRE');
      expect(opts.keys[0]).toContain('ratelimit:test:tenant-alpha:');
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4);
    });

    it('falls back to incr + pExpire when client.eval is not implemented', async () => {
      const incrMock = vi.fn().mockResolvedValue(1);
      const pExpireMock = vi.fn().mockResolvedValue(true);
      const mockClient: RateLimitRedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        incr: incrMock,
        pExpire: pExpireMock,
      };

      const limiter = new RedisRateLimiter({
        url: 'redis://localhost:6379',
        maxRequests: 2,
        windowMs: 60000,
        prefix: 'ratelimit:test',
        client: mockClient,
      });

      const res1 = await limiter.check('tenant-beta');
      expect(incrMock).toHaveBeenCalledTimes(1);
      expect(pExpireMock).toHaveBeenCalledWith(expect.stringContaining('ratelimit:test:tenant-beta:'), 120000);
      expect(res1.allowed).toBe(true);
      expect(res1.remaining).toBe(1);

      // Second hit (count = 2)
      incrMock.mockResolvedValueOnce(2);
      const res2 = await limiter.check('tenant-beta');
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(0);

      // Third hit (count = 3, exceeds limit)
      incrMock.mockResolvedValueOnce(3);
      const res3 = await limiter.check('tenant-beta');
      expect(res3.allowed).toBe(false);
      expect(res3.remaining).toBe(0);
    });

    it('deduplicates concurrent connect() calls', async () => {
      let connectCallCount = 0;
      let resolveConnect: () => void;
      const connectPromise = new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

      const mockClient: RateLimitRedisClientLike = {
        isOpen: false,
        connect: vi.fn().mockImplementation(async () => {
          connectCallCount++;
          await connectPromise;
          mockClient.isOpen = true;
        }),
        incr: vi.fn().mockResolvedValue(1),
        pExpire: vi.fn().mockResolvedValue(true),
      };

      const limiter = new RedisRateLimiter({
        url: 'redis://localhost:6379',
        maxRequests: 10,
        windowMs: 60000,
        client: mockClient,
      });

      const check1 = limiter.check('t1');
      const check2 = limiter.check('t1');
      const check3 = limiter.check('t1');

      resolveConnect!();

      const [r1, r2, r3] = await Promise.all([check1, check2, check3]);
      expect(connectCallCount).toBe(1);
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
    });

    it('gracefully shuts down client on close()', async () => {
      const quitMock = vi.fn().mockResolvedValue('OK');
      const mockClient: RateLimitRedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        quit: quitMock,
        incr: vi.fn(),
        pExpire: vi.fn(),
      };

      const limiter = new RedisRateLimiter({
        url: 'redis://localhost:6379',
        maxRequests: 10,
        windowMs: 60000,
        client: mockClient,
      });

      await limiter.close();
      expect(quitMock).toHaveBeenCalledTimes(1);

      // Second check after close should fail
      await expect(limiter.check('t1')).rejects.toThrow(RateLimiterStoreError);
    });
  });

  describe('3. Redis Failure Modes: fail-closed vs fail-open', () => {
    it('fail-closed throws RateLimiterStoreError on Redis failure and redacts secrets', async () => {
      const sensitiveUrl = 'redis://:superSecretPassword@cluster.internal:6379';
      const mockClient: RateLimitRedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        incr: vi.fn().mockRejectedValue(new Error(`Connection to ${sensitiveUrl} failed with ECONNRESET`)),
        pExpire: vi.fn(),
      };

      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const limiter = new RedisRateLimiter({
        url: sensitiveUrl,
        maxRequests: 10,
        windowMs: 60000,
        failureMode: 'fail-closed',
        client: mockClient,
        logger,
      });

      await expect(limiter.check('tenant-err')).rejects.toThrow(RateLimiterStoreError);

      // Verify credentials are redacted in logged error
      expect(logger.error).toHaveBeenCalled();
      const loggedError = logger.error.mock.calls[0][0].error;
      expect(loggedError).not.toContain('superSecretPassword');
      expect(loggedError).toContain('***');
    });

    it('fail-open allows requests with degraded flag on Redis failure', async () => {
      const mockClient: RateLimitRedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        incr: vi.fn().mockRejectedValue(new Error('Redis timeout')),
        pExpire: vi.fn(),
      };

      const limiter = new RedisRateLimiter({
        url: 'redis://localhost:6379',
        maxRequests: 10,
        windowMs: 60000,
        failureMode: 'fail-open',
        client: mockClient,
      });

      const res = await limiter.check('tenant-degraded');
      expect(res.allowed).toBe(true);
      expect(res.degraded).toBe(true);
      expect(res.retryAfterSeconds).toBe(0);
    });
  });

  describe('4. Gateway Integration: End-to-End Rate Limiting in buildServer', () => {
    it('sets standard rate limit headers on allowed requests', async () => {
      const memoryLimiter = new MemoryRateLimiter({ maxRequests: 5, windowMs: 60000 });

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
          createChatCompletion: vi.fn().mockResolvedValue({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gemini-1.5-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          }),
        },
        rateLimiter: memoryLimiter,
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('5');
      expect(res.headers['x-ratelimit-remaining']).toBe('4');
      expect(res.headers['x-ratelimit-reset']).toBeDefined();

      await app.close();
    });

    it('returns HTTP 429 RATE_LIMIT_EXCEEDED with Retry-After when limit is reached', async () => {
      const memoryLimiter = new MemoryRateLimiter({ maxRequests: 2, windowMs: 60000 });

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
          createChatCompletion: vi.fn().mockResolvedValue({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gemini-1.5-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
        },
        rateLimiter: memoryLimiter,
      });

      await app.ready();

      // Request 1: 200 (remaining: 1)
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'msg 1' }] },
      });
      expect(res1.statusCode).toBe(200);

      // Request 2: 200 (remaining: 0)
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'msg 2' }] },
      });
      expect(res2.statusCode).toBe(200);

      // Request 3: 429 Too Many Requests
      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'msg 3' }] },
      });

      expect(res3.statusCode).toBe(429);
      expect(res3.headers['retry-after']).toBeDefined();
      expect(Number(res3.headers['retry-after'])).toBeGreaterThan(0);
      expect(res3.headers['x-ratelimit-remaining']).toBe('0');

      const body = JSON.parse(res3.payload);
      expect(body.error).toBe('Too Many Requests');
      expect(body.message).toBe('Rate limit exceeded. Please try again later.');
      expect(body.code).toBe('RATE_LIMIT_EXCEEDED');

      await app.close();
    });

    it('enforces tenant isolation across multiple tenants', async () => {
      const memoryLimiter = new MemoryRateLimiter({ maxRequests: 1, windowMs: 60000 });

      // We'll test with custom auth handler to simulate 2 tenants
      const app = Fastify({ logger: false });

      // Auth middleware that switches tenantId based on apiKey
      app.addHook('onRequest', async (req, reply) => {
        const header = req.headers.authorization;
        if (!header) return reply.code(401).send({ error: 'Unauthorized' });
        const token = header.split(' ')[1];
        if (token === 'key-tenant-1') {
          req.user = { tenantId: 'tenant-1', apiKeyPrefix: 'key-tena' };
        } else if (token === 'key-tenant-2') {
          req.user = { tenantId: 'tenant-2', apiKeyPrefix: 'key-tena' };
        } else {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
      });

      app.addHook(
        'preHandler',
        createRateLimitMiddleware({ rateLimiter: memoryLimiter, skipPaths: ['/health'] })
      );

      app.post('/v1/chat/completions', async () => ({ status: 'ok' }));

      await app.ready();

      // Tenant 1 request 1 -> OK
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer key-tenant-1' },
      });
      expect(res1.statusCode).toBe(200);

      // Tenant 1 request 2 -> 429
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer key-tenant-1' },
      });
      expect(res2.statusCode).toBe(429);

      // Tenant 2 request 1 -> OK (Tenant 2 has independent quota)
      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer key-tenant-2' },
      });
      expect(res3.statusCode).toBe(200);
      expect(res3.headers['x-ratelimit-remaining']).toBe('0');

      await app.close();
    });

    it('bypasses public endpoints like /health', async () => {
      const memoryLimiter = new MemoryRateLimiter({ maxRequests: 1, windowMs: 60000 });

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
        rateLimiter: memoryLimiter,
      });

      await app.ready();

      // /health calls should not be rate-limited and should not have rate limit headers
      const res1 = await app.inject({ method: 'GET', url: '/health' });
      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-ratelimit-limit']).toBeUndefined();

      const res2 = await app.inject({ method: 'GET', url: '/health' });
      expect(res2.statusCode).toBe(200);

      await app.close();
    });

    it('returns HTTP 503 RATE_LIMIT_ERROR when Redis rate limiter fails under fail-closed', async () => {
      const mockFailingLimiter = {
        check: vi.fn().mockRejectedValue(new RateLimiterStoreError('Redis connection lost')),
        close: vi.fn().mockResolvedValue(undefined),
      };

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
        rateLimiter: mockFailingLimiter,
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Service Unavailable');
      expect(body.code).toBe('RATE_LIMIT_ERROR');
      expect(body.message).toContain('Unable to verify rate limit');

      await app.close();
    });

    it('returns 200 with X-RateLimit-Degraded when Redis rate limiter fails under fail-open', async () => {
      const mockDegradedLimiter = {
        check: vi.fn().mockResolvedValue({
          allowed: true,
          limit: 60,
          remaining: 60,
          resetTimeMs: Date.now() + 60000,
          retryAfterSeconds: 0,
          degraded: true,
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

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
          createChatCompletion: vi.fn().mockResolvedValue({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1000,
            model: 'gemini-1.5-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'degraded ok' }, finish_reason: 'stop' }],
          }),
        },
        rateLimiter: mockDegradedLimiter,
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-degraded']).toBe('true');

      await app.close();
    });
  });
});
