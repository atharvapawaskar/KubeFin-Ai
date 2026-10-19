import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerState,
  isTransientError,
  calculateRetryDelay,
  executeWithRetry,
  buildServer,
} from '../src/index.js';
import {
  loadCircuitBreakerConfig,
  loadRetryConfig,
  loadResilienceConfig,
} from '../src/config.js';

describe('Task 4.1: Upstream Retry & Circuit Breaker', () => {
  const API_KEY = 'test-api-key-resilience';
  const TENANT_ID = 'test-tenant-resilience';

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Configuration Parsing & Validation
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Configuration Parsing & Validation', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.CIRCUIT_BREAKER_ENABLED;
      delete process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
      delete process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
      delete process.env.CIRCUIT_BREAKER_HALF_OPEN_PROBES;
      delete process.env.UPSTREAM_MAX_RETRIES;
      delete process.env.UPSTREAM_RETRY_BASE_DELAY_MS;
      delete process.env.UPSTREAM_RETRY_MAX_DELAY_MS;
    });

    it('loads default resilience configuration when no environment variables are set', () => {
      const config = loadResilienceConfig();

      expect(config.circuitBreaker.enabled).toBe(true);
      expect(config.circuitBreaker.failureThreshold).toBe(5);
      expect(config.circuitBreaker.resetTimeoutMs).toBe(30000);
      expect(config.circuitBreaker.halfOpenMaxProbes).toBe(1);

      expect(config.retry.maxRetries).toBe(2);
      expect(config.retry.baseDelayMs).toBe(200);
      expect(config.retry.maxDelayMs).toBe(2000);
    });

    it('parses valid custom circuit breaker and retry configuration', () => {
      process.env.CIRCUIT_BREAKER_ENABLED = 'true';
      process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '10';
      process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = '15000';
      process.env.CIRCUIT_BREAKER_HALF_OPEN_PROBES = '3';

      process.env.UPSTREAM_MAX_RETRIES = '4';
      process.env.UPSTREAM_RETRY_BASE_DELAY_MS = '100';
      process.env.UPSTREAM_RETRY_MAX_DELAY_MS = '5000';

      const config = loadResilienceConfig();

      expect(config.circuitBreaker.enabled).toBe(true);
      expect(config.circuitBreaker.failureThreshold).toBe(10);
      expect(config.circuitBreaker.resetTimeoutMs).toBe(15000);
      expect(config.circuitBreaker.halfOpenMaxProbes).toBe(3);

      expect(config.retry.maxRetries).toBe(4);
      expect(config.retry.baseDelayMs).toBe(100);
      expect(config.retry.maxDelayMs).toBe(5000);
    });

    it('disables circuit breaker when CIRCUIT_BREAKER_ENABLED is "false"', () => {
      process.env.CIRCUIT_BREAKER_ENABLED = 'false';
      const config = loadCircuitBreakerConfig();
      expect(config.enabled).toBe(false);
    });

    it('rejects invalid CIRCUIT_BREAKER_FAILURE_THRESHOLD', () => {
      process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '0';
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer/);

      process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '-5';
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer/);

      process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = 'not-a-number';
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer/);

      process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '2000'; // above 1000
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer/);
    });

    it('rejects invalid CIRCUIT_BREAKER_RESET_TIMEOUT_MS', () => {
      process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = '50'; // below 100ms
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_RESET_TIMEOUT_MS must be a positive integer/);

      process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 'abc';
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_RESET_TIMEOUT_MS must be a positive integer/);
    });

    it('rejects invalid CIRCUIT_BREAKER_HALF_OPEN_PROBES', () => {
      process.env.CIRCUIT_BREAKER_HALF_OPEN_PROBES = '0';
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_HALF_OPEN_PROBES must be a positive integer/);

      process.env.CIRCUIT_BREAKER_HALF_OPEN_PROBES = '500';
      expect(() => loadCircuitBreakerConfig()).toThrow(/CIRCUIT_BREAKER_HALF_OPEN_PROBES must be a positive integer/);
    });

    it('rejects invalid UPSTREAM_MAX_RETRIES', () => {
      process.env.UPSTREAM_MAX_RETRIES = '-1';
      expect(() => loadRetryConfig()).toThrow(/UPSTREAM_MAX_RETRIES must be an integer between 0 and 10/);

      process.env.UPSTREAM_MAX_RETRIES = '15';
      expect(() => loadRetryConfig()).toThrow(/UPSTREAM_MAX_RETRIES must be an integer between 0 and 10/);
    });

    it('rejects invalid UPSTREAM_RETRY_BASE_DELAY_MS', () => {
      process.env.UPSTREAM_RETRY_BASE_DELAY_MS = '5'; // below 10ms
      expect(() => loadRetryConfig()).toThrow(/UPSTREAM_RETRY_BASE_DELAY_MS must be a positive integer between 10 and 60000/);
    });

    it('rejects UPSTREAM_RETRY_MAX_DELAY_MS less than base delay', () => {
      process.env.UPSTREAM_RETRY_BASE_DELAY_MS = '1000';
      process.env.UPSTREAM_RETRY_MAX_DELAY_MS = '500';
      expect(() => loadRetryConfig()).toThrow(/UPSTREAM_RETRY_MAX_DELAY_MS must be a positive integer greater than or equal to UPSTREAM_RETRY_BASE_DELAY_MS/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Circuit Breaker State Machine Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Circuit Breaker State Machine Unit Tests', () => {
    let mockCurrentTime = 10000;
    const getMockTime = () => mockCurrentTime;

    it('starts in CLOSED state and allows requests', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: getMockTime });

      expect(cb.getState()).toBe('CLOSED');
      const permit = cb.acquirePermit();
      expect(permit.allowed).toBe(true);
      expect(permit.isProbe).toBe(false);
      expect(permit.state).toBe('CLOSED');
    });

    it('tracks consecutive failures below threshold and resets on success', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: getMockTime });

      cb.recordFailure();
      expect(cb.getStats().consecutiveFailures).toBe(1);
      expect(cb.getState()).toBe('CLOSED');

      cb.recordFailure();
      expect(cb.getStats().consecutiveFailures).toBe(2);
      expect(cb.getState()).toBe('CLOSED');

      // Success resets consecutive failures counter
      cb.recordSuccess();
      expect(cb.getStats().consecutiveFailures).toBe(0);
      expect(cb.getState()).toBe('CLOSED');
    });

    it('transitions to OPEN when threshold is reached and fast-fails', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: getMockTime });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe('OPEN');
      const permit = cb.acquirePermit();
      expect(permit.allowed).toBe(false);
      expect(permit.isProbe).toBe(false);
      expect(permit.state).toBe('OPEN');
      expect(permit.reason).toContain('Circuit is OPEN');
    });

    it('remains OPEN until cooldown period elapses', () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5000, now: getMockTime });

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('OPEN');

      // Advance time by 4999ms (1ms before timeout)
      mockCurrentTime += 4999;
      expect(cb.getState()).toBe('OPEN');
      expect(cb.acquirePermit().allowed).toBe(false);

      // Advance by 1ms to reach 5000ms cooldown
      mockCurrentTime += 1;
      expect(cb.getState()).toBe('HALF_OPEN');
    });

    it('allows limited probes in HALF_OPEN state and blocks concurrent probes', () => {
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1000,
        halfOpenMaxProbes: 1,
        now: getMockTime,
      });

      // Trip to OPEN
      cb.recordFailure();
      cb.recordFailure();

      // Elapse cooldown
      mockCurrentTime += 1000;
      expect(cb.getState()).toBe('HALF_OPEN');

      // First request gets probe permit
      const probePermit = cb.acquirePermit();
      expect(probePermit.allowed).toBe(true);
      expect(probePermit.isProbe).toBe(true);
      expect(probePermit.state).toBe('HALF_OPEN');

      // Second concurrent request while probe is in-flight is denied
      const concurrentPermit = cb.acquirePermit();
      expect(concurrentPermit.allowed).toBe(false);
      expect(concurrentPermit.isProbe).toBe(false);
      expect(concurrentPermit.state).toBe('HALF_OPEN');
      expect(concurrentPermit.reason).toContain('Probes saturated');
    });

    it('probe success in HALF_OPEN fully recovers and closes the circuit', () => {
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1000,
        halfOpenMaxProbes: 1,
        now: getMockTime,
      });

      cb.recordFailure();
      cb.recordFailure();
      mockCurrentTime += 1000;

      const probePermit = cb.acquirePermit();
      expect(probePermit.isProbe).toBe(true);

      // Probe succeeds!
      cb.recordSuccess(probePermit);

      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getStats().consecutiveFailures).toBe(0);
      expect(cb.acquirePermit().allowed).toBe(true);
    });

    it('probe failure in HALF_OPEN immediately reopens circuit for another cooldown', () => {
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1000,
        halfOpenMaxProbes: 1,
        now: getMockTime,
      });

      cb.recordFailure();
      cb.recordFailure();
      mockCurrentTime += 1000;

      const probePermit = cb.acquirePermit();
      expect(probePermit.isProbe).toBe(true);

      // Probe fails!
      cb.recordFailure(probePermit, new Error('Upstream down'));

      expect(cb.getState()).toBe('OPEN');
      expect(cb.acquirePermit().allowed).toBe(false);

      // Needs another full 1000ms to enter HALF_OPEN again
      mockCurrentTime += 500;
      expect(cb.getState()).toBe('OPEN');
      mockCurrentTime += 500;
      expect(cb.getState()).toBe('HALF_OPEN');
    });

    it('supports forceOpen, forceClose, and reset', () => {
      const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1000 });

      cb.forceOpen();
      expect(cb.getState()).toBe('OPEN');

      cb.forceClose();
      expect(cb.getState()).toBe('CLOSED');

      cb.recordFailure();
      expect(cb.getStats().consecutiveFailures).toBe(1);
      cb.reset();
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getStats().consecutiveFailures).toBe(0);
    });

    it('always permits requests when disabled', () => {
      const cb = new CircuitBreaker({ enabled: false, failureThreshold: 1 });

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.acquirePermit().allowed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Transient Error Classification Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Transient Error Classification Unit Tests', () => {
    it('classifies 503, 502, 500, and 429 as transient (retryable)', () => {
      expect(isTransientError({ status: 503, message: 'Service Unavailable' })).toBe(true);
      expect(isTransientError({ statusCode: 503, message: 'Service Unavailable' })).toBe(true);
      expect(isTransientError({ status: 502, message: 'Bad Gateway' })).toBe(true);
      expect(isTransientError({ status: 500, message: 'Internal Server Error' })).toBe(true);
      expect(isTransientError({ status: 429, message: 'Rate Limit Exceeded' })).toBe(true);
      expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isTransientError(new Error('429 Resource has been exhausted'))).toBe(true);
      expect(isTransientError(new Error('Model is temporarily overloaded'))).toBe(true);
      expect(isTransientError({ code: 'ECONNREFUSED', message: 'Connection refused' })).toBe(true);
    });

    it('never retries timeouts, aborts, or deadlines (conservative double-billing prevention)', () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      expect(isTransientError(abortErr)).toBe(false);

      const timeoutErr = new Error('Request timed out after 30000ms');
      timeoutErr.name = 'TimeoutError';
      expect(isTransientError(timeoutErr)).toBe(false);

      expect(isTransientError({ code: 'ETIMEDOUT', message: 'Connect timeout' })).toBe(false);
      expect(isTransientError({ code: 'PROVIDER_TIMEOUT', message: 'Provider timeout' })).toBe(false);
      expect(isTransientError(new Error('deadline exceeded'))).toBe(false);
    });

    it('never retries connection resets (conservative double-billing prevention)', () => {
      expect(isTransientError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(false);
      expect(isTransientError(new Error('connection reset by peer'))).toBe(false);
    });

    it('never retries authentication errors', () => {
      expect(isTransientError({ status: 401, message: 'Unauthorized' })).toBe(false);
      expect(isTransientError({ code: 'PROVIDER_AUTH_ERROR', message: 'Invalid API key' })).toBe(false);
      expect(isTransientError(new Error('401 invalid api key configuration'))).toBe(false);
    });

    it('never retries client 4xx errors (except 429)', () => {
      expect(isTransientError({ status: 400, message: 'Bad Request' })).toBe(false);
      expect(isTransientError({ status: 403, message: 'Forbidden' })).toBe(false);
      expect(isTransientError({ status: 404, message: 'Not Found' })).toBe(false);
      expect(isTransientError({ status: 413, message: 'Payload Too Large' })).toBe(false);
    });

    it('never retries circuit breaker open errors', () => {
      expect(isTransientError({ code: 'CIRCUIT_BREAKER_OPEN', message: 'circuit breaker is open' })).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Exponential Backoff & Jitter Calculation
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Exponential Backoff & Jitter Calculation', () => {
    it('calculates deterministic exponential backoff when jitter is disabled', () => {
      const baseDelayMs = 100;
      const maxDelayMs = 1000;

      expect(calculateRetryDelay({ attempt: 1, baseDelayMs, maxDelayMs, jitter: false })).toBe(100);
      expect(calculateRetryDelay({ attempt: 2, baseDelayMs, maxDelayMs, jitter: false })).toBe(200);
      expect(calculateRetryDelay({ attempt: 3, baseDelayMs, maxDelayMs, jitter: false })).toBe(400);
      expect(calculateRetryDelay({ attempt: 4, baseDelayMs, maxDelayMs, jitter: false })).toBe(800);
      expect(calculateRetryDelay({ attempt: 5, baseDelayMs, maxDelayMs, jitter: false })).toBe(1000); // capped at max
      expect(calculateRetryDelay({ attempt: 6, baseDelayMs, maxDelayMs, jitter: false })).toBe(1000); // capped at max
    });

    it('applies bounded jitter (between 50% and 100% of exponential delay)', () => {
      const baseDelayMs = 200;
      const maxDelayMs = 2000;

      // Minimum jitter (random = 0)
      const minDelay = calculateRetryDelay({
        attempt: 1,
        baseDelayMs,
        maxDelayMs,
        jitter: true,
        randomFn: () => 0,
      });
      expect(minDelay).toBe(100); // 200 * 0.5

      // Maximum jitter (random = 1)
      const maxDelay = calculateRetryDelay({
        attempt: 1,
        baseDelayMs,
        maxDelayMs,
        jitter: true,
        randomFn: () => 1,
      });
      expect(maxDelay).toBe(200); // 200 * 1.0
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. executeWithRetry Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('5. executeWithRetry Unit Tests', () => {
    it('returns result immediately on initial success without retry', async () => {
      const fn = vi.fn().mockResolvedValue('success-val');
      const sleep = vi.fn();

      const result = await executeWithRetry({
        fn,
        maxRetries: 2,
        baseDelayMs: 50,
        maxDelayMs: 500,
        sleep,
      });

      expect(result).toBe('success-val');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('retries transient error and returns result on subsequent success', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
        .mockResolvedValueOnce('retry-success');
      const sleep = vi.fn().mockResolvedValue(undefined);
      const onRetry = vi.fn();

      const result = await executeWithRetry({
        fn,
        maxRetries: 2,
        baseDelayMs: 50,
        maxDelayMs: 500,
        sleep,
        onRetry,
      });

      expect(result).toBe('retry-success');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not retry non-transient errors (e.g. timeout / auth)', async () => {
      const timeoutErr = new Error('The operation was aborted');
      timeoutErr.name = 'AbortError';

      const fn = vi.fn().mockRejectedValue(timeoutErr);
      const sleep = vi.fn();

      await expect(
        executeWithRetry({
          fn,
          maxRetries: 2,
          baseDelayMs: 50,
          maxDelayMs: 500,
          sleep,
        })
      ).rejects.toThrow('The operation was aborted');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('throws final error when maxRetries is exhausted', async () => {
      const transientErr = { status: 503, message: 'Service Unavailable' };
      const fn = vi.fn().mockRejectedValue(transientErr);
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(
        executeWithRetry({
          fn,
          maxRetries: 2,
          baseDelayMs: 50,
          maxDelayMs: 500,
          sleep,
        })
      ).rejects.toMatchObject({ status: 503 });

      // 1 initial attempt + 2 retries = 3 attempts total
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Gateway Integration Tests (buildServer)
  // ──────────────────────────────────────────────────────────────────────────
  describe('6. Gateway Integration Tests (buildServer)', () => {
    it('retries transient 503 error, succeeds, and publishes exactly ONE usage event', async () => {
      const mockCreateCompletion = vi
        .fn()
        .mockRejectedValueOnce({ status: 503, message: '503 Service Unavailable' })
        .mockResolvedValueOnce({
          id: 'chat-ok',
          object: 'chat.completion',
          created: 12345,
          model: 'gemini-1.5-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello after retry' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });

      const publishedEvents: any[] = [];
      const mockPublisher = {
        publish: vi.fn().mockImplementation(async (event) => {
          publishedEvents.push(event);
          return { success: true, messageId: 'msg-1' };
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: true, maxRetries: 1, retryDelayMs: 0 },
        },
        circuitBreaker: cb,
        resilience: {
          circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxProbes: 1 },
          retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
        },
        retrySleep: vi.fn().mockResolvedValue(undefined), // zero sleep for fast test
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
        usagePublisher: mockPublisher,
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'ping' }] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.choices[0].message.content).toBe('hello after retry');

      // Provider was called twice (1 initial + 1 retry)
      expect(mockCreateCompletion).toHaveBeenCalledTimes(2);

      // Exactly ONE usage event emitted
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0].usage.inputTokens).toBe(10);
      expect(publishedEvents[0].usage.outputTokens).toBe(20);

      // Circuit breaker is CLOSED and healthy
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getStats().consecutiveFailures).toBe(0);

      await app.close();
    });

    it('does NOT retry timeouts and returns HTTP 504 without duplicate calls or billing', async () => {
      const timeoutErr = new Error('The operation was aborted');
      timeoutErr.name = 'AbortError';

      const mockCreateCompletion = vi.fn().mockRejectedValue(timeoutErr);
      const mockPublisher = {
        publish: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: true, maxRetries: 1, retryDelayMs: 0 },
        },
        circuitBreaker: cb,
        resilience: {
          circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxProbes: 1 },
          retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
        },
        retrySleep: vi.fn(),
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
        usagePublisher: mockPublisher,
      });

      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'ping' }] },
      });

      expect(res.statusCode).toBe(504);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('PROVIDER_TIMEOUT');

      // Crucial: Provider was called only ONCE (no retry on timeout!)
      expect(mockCreateCompletion).toHaveBeenCalledTimes(1);

      // Zero usage events emitted
      expect(mockPublisher.publish).not.toHaveBeenCalled();

      // Counts as failure towards circuit breaker
      expect(cb.getStats().consecutiveFailures).toBe(1);

      await app.close();
    });

    it('trips circuit breaker after consecutive failures and fast-fails with HTTP 503 CIRCUIT_BREAKER_OPEN', async () => {
      const mockCreateCompletion = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
      const mockPublisher = {
        publish: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10000 });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: true, maxRetries: 1, retryDelayMs: 0 },
        },
        circuitBreaker: cb,
        resilience: {
          circuitBreaker: { enabled: true, failureThreshold: 2, resetTimeoutMs: 10000, halfOpenMaxProbes: 1 },
          retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
        },
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
        usagePublisher: mockPublisher,
      });

      await app.ready();

      // Request 1: fails
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'req-1' }] },
      });
      expect(res1.statusCode).toBe(502);
      expect(cb.getState()).toBe('CLOSED');

      // Request 2: fails -> trips circuit breaker to OPEN!
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'req-2' }] },
      });
      expect(res2.statusCode).toBe(502);
      expect(cb.getState()).toBe('OPEN');

      const callCountBeforeTrip = mockCreateCompletion.mock.calls.length;

      // Request 3: Circuit is OPEN -> Fast-fails immediately!
      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'req-3' }] },
      });

      expect(res3.statusCode).toBe(503);
      const body3 = JSON.parse(res3.payload);
      expect(body3.code).toBe('CIRCUIT_BREAKER_OPEN');
      expect(body3.error).toBe('Service Unavailable');
      expect(body3.message).toContain('Upstream circuit breaker is OPEN. Fast-failing request.');

      // Provider was NOT called on fast-fail
      expect(mockCreateCompletion.mock.calls.length).toBe(callCountBeforeTrip);

      // No usage event published
      expect(mockPublisher.publish).not.toHaveBeenCalled();

      await app.close();
    });

    it('recovers to CLOSED via HALF_OPEN probe after cooldown elapses', async () => {
      let mockTime = 1000;
      const getMockTime = () => mockTime;

      const mockCreateCompletion = vi.fn();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 5000,
        halfOpenMaxProbes: 1,
        now: getMockTime,
      });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
        },
        circuitBreaker: cb,
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
      });

      await app.ready();

      // 1. Initial failure trips breaker
      mockCreateCompletion.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(cb.getState()).toBe('OPEN');

      // 2. Immediate request fast-fails
      const resFastFail = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(resFastFail.statusCode).toBe(503);

      // 3. Cooldown elapses: advance time by 5000ms
      mockTime += 5000;
      expect(cb.getState()).toBe('HALF_OPEN');

      // 4. Probe request succeeds!
      mockCreateCompletion.mockResolvedValueOnce({
        id: 'probe-chat',
        object: 'chat.completion',
        created: 12345,
        model: 'gemini-1.5-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'probe recovered' }, finish_reason: 'stop' }],
      });

      const resProbe = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'probe' }] },
      });

      expect(resProbe.statusCode).toBe(200);
      expect(cb.getState()).toBe('CLOSED');

      // 5. Subsequent request succeeds in CLOSED state
      mockCreateCompletion.mockResolvedValueOnce({
        id: 'subsequent-chat',
        object: 'chat.completion',
        created: 12346,
        model: 'gemini-1.5-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'all normal' }, finish_reason: 'stop' }],
      });

      const resSubsequent = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'normal' }] },
      });
      expect(resSubsequent.statusCode).toBe(200);

      await app.close();
    });

    it('probe failure in HALF_OPEN reopens circuit breaker', async () => {
      let mockTime = 1000;
      const getMockTime = () => mockTime;

      const mockCreateCompletion = vi.fn();
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 5000,
        halfOpenMaxProbes: 1,
        now: getMockTime,
      });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
        },
        circuitBreaker: cb,
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
      });

      await app.ready();

      // Trip to OPEN
      cb.forceOpen();
      expect(cb.getState()).toBe('OPEN');

      // Cooldown elapses
      mockTime += 5000;
      expect(cb.getState()).toBe('HALF_OPEN');

      // Probe fails
      mockCreateCompletion.mockRejectedValueOnce(new Error('503 Still Broken'));
      const resProbe = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'probe' }] },
      });
      expect(resProbe.statusCode).toBe(502);

      // Reopened back to OPEN
      expect(cb.getState()).toBe('OPEN');

      // Next request fast-fails
      const resFastFail = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test' }] },
      });
      expect(resFastFail.statusCode).toBe(503);

      await app.close();
    });

    it('allows /health and /metrics when upstream circuit breaker is OPEN', async () => {
      const cb = new CircuitBreaker();
      cb.forceOpen();

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
        circuitBreaker: cb,
      });

      await app.ready();

      // /health returns 200
      const resHealth = await app.inject({ method: 'GET', url: '/health' });
      expect(resHealth.statusCode).toBe(200);

      // /metrics returns 200
      const resMetrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(resMetrics.statusCode).toBe(200);

      await app.close();
    });

    it('failure count is per logical request: 1 logical request with 2 retries only counts as 1 failure', async () => {
      const mockCreateCompletion = vi.fn().mockRejectedValue({ status: 503, message: '503 Service Unavailable' });
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000 });

      const app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'dummy-key', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'events', enabled: false, maxRetries: 1, retryDelayMs: 0 },
        },
        circuitBreaker: cb,
        resilience: {
          circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 10000, halfOpenMaxProbes: 1 },
          retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
        },
        retrySleep: vi.fn().mockResolvedValue(undefined),
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateCompletion,
        },
      });

      await app.ready();

      // Send 1 logical request that fails all 3 attempts (1 initial + 2 retries)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'test-accounting' }] },
      });

      expect(res.statusCode).toBe(502);
      expect(mockCreateCompletion).toHaveBeenCalledTimes(3);

      // Failure count is strictly 1 (NOT 3)
      expect(cb.getStats().consecutiveFailures).toBe(1);
      expect(cb.getState()).toBe('CLOSED');

      await app.close();
    });

    it('stale success from an earlier closed epoch does NOT close an OPEN or HALF_OPEN circuit', () => {
      let mockTime = 1000;
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenMaxProbes: 1,
        now: () => mockTime,
      });

      // Request A starts in CLOSED state
      const permitA = cb.acquirePermit();
      expect(permitA.state).toBe('CLOSED');
      expect(permitA.isProbe).toBe(false);

      // Requests B and C fail, tripping the breaker to OPEN
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('OPEN');

      // Request A finishes with success now while circuit is OPEN
      cb.recordSuccess(permitA);
      // Crucial: stale success must NOT close the OPEN circuit!
      expect(cb.getState()).toBe('OPEN');

      // Cooldown elapses: circuit enters HALF_OPEN
      mockTime += 5000;
      expect(cb.getState()).toBe('HALF_OPEN');

      // Another stale success from an earlier CLOSED permit must NOT close HALF_OPEN
      cb.recordSuccess(permitA);
      expect(cb.getState()).toBe('HALF_OPEN');

      // Only a genuine probe permit can close HALF_OPEN
      const probePermit = cb.acquirePermit();
      expect(probePermit.isProbe).toBe(true);
      cb.recordSuccess(probePermit);
      expect(cb.getState()).toBe('CLOSED');
    });

    it('releases probe permit via release() when exception occurs before completion', () => {
      let mockTime = 1000;
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 5000,
        halfOpenMaxProbes: 1,
        now: () => mockTime,
      });

      cb.forceOpen();
      mockTime += 5000;
      expect(cb.getState()).toBe('HALF_OPEN');

      const probePermit = cb.acquirePermit();
      expect(cb.getStats().activeProbes).toBe(1);

      // Subsequent concurrent probe is blocked
      expect(cb.acquirePermit().allowed).toBe(false);

      // Exception occurs / dropped request releases permit
      probePermit.release?.();
      expect(cb.getStats().activeProbes).toBe(0);

      // New probe can now be acquired
      expect(cb.acquirePermit().allowed).toBe(true);
    });

    it('cancels backoff sleep immediately when AbortSignal is triggered', async () => {
      const abortController = new AbortController();
      const fn = vi.fn().mockRejectedValue({ status: 503, message: '503 Service Unavailable' });

      // Trigger abort after 10ms
      setTimeout(() => abortController.abort(), 10);

      const startTime = Date.now();
      await expect(
        executeWithRetry({
          fn,
          maxRetries: 3,
          baseDelayMs: 5000, // Long delay
          maxDelayMs: 10000,
          signal: abortController.signal,
        })
      ).rejects.toThrow('The operation was aborted');

      const elapsed = Date.now() - startTime;
      // Must abort immediately without waiting out the 5000ms delay!
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
