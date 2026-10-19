import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { loadPolicyConfig } from '../src/config.js';
import { isModelAllowed, isMaxTokensExceeded } from '../src/middleware/policy.js';

const API_KEY = 'test-policy-key-12345';
const TENANT_ID = 'test-policy-tenant';

describe('Gateway Policy Engine', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('1. Configuration Parsing & Validation (loadPolicyConfig)', () => {
    it('returns undefined for both allowedModels and maxTokensLimit when unset', () => {
      delete process.env.GATEWAY_ALLOWED_MODELS;
      delete process.env.GATEWAY_MAX_TOKENS_LIMIT;

      const config = loadPolicyConfig();
      expect(config.allowedModels).toBeUndefined();
      expect(config.maxTokensLimit).toBeUndefined();
    });

    it('parses, trims, and deduplicates valid GATEWAY_ALLOWED_MODELS', () => {
      process.env.GATEWAY_ALLOWED_MODELS = ' gemini-1.5-flash , gemini-3.6-flash, gemini-1.5-flash ';
      const config = loadPolicyConfig();
      expect(config.allowedModels).toEqual(['gemini-1.5-flash', 'gemini-3.6-flash']);
    });

    it('rejects empty or whitespace-only GATEWAY_ALLOWED_MODELS', () => {
      process.env.GATEWAY_ALLOWED_MODELS = '   ';
      expect(() => loadPolicyConfig()).toThrow(/GATEWAY_ALLOWED_MODELS must contain at least one valid model identifier/);
    });

    it('rejects empty entries in comma-separated GATEWAY_ALLOWED_MODELS', () => {
      process.env.GATEWAY_ALLOWED_MODELS = 'gemini-1.5-flash,,gemini-3.6-flash';
      expect(() => loadPolicyConfig()).toThrow(/must not contain empty model identifiers/);

      process.env.GATEWAY_ALLOWED_MODELS = ',';
      expect(() => loadPolicyConfig()).toThrow(/must not contain empty model identifiers/);
    });

    it('rejects invalid model identifiers in GATEWAY_ALLOWED_MODELS', () => {
      process.env.GATEWAY_ALLOWED_MODELS = 'invalid model with spaces';
      expect(() => loadPolicyConfig()).toThrow(/contains invalid model identifiers/);

      process.env.GATEWAY_ALLOWED_MODELS = 'a'.repeat(257);
      expect(() => loadPolicyConfig()).toThrow(/contains invalid model identifiers/);
    });

    it('parses valid positive integer GATEWAY_MAX_TOKENS_LIMIT', () => {
      process.env.GATEWAY_MAX_TOKENS_LIMIT = ' 4096 ';
      const config = loadPolicyConfig();
      expect(config.maxTokensLimit).toBe(4096);
    });

    it('rejects non-numeric, decimal, negative, or zero GATEWAY_MAX_TOKENS_LIMIT', () => {
      process.env.GATEWAY_MAX_TOKENS_LIMIT = 'abc';
      expect(() => loadPolicyConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_TOKENS_LIMIT = '4096.5';
      expect(() => loadPolicyConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_TOKENS_LIMIT = '0';
      expect(() => loadPolicyConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_TOKENS_LIMIT = '-100';
      expect(() => loadPolicyConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_TOKENS_LIMIT = '2147483648';
      expect(() => loadPolicyConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);
    });
  });

  describe('2. Pure Policy Helper Unit Tests', () => {
    it('isModelAllowed returns true when allow-list is undefined or empty', () => {
      expect(isModelAllowed('gemini-1.5-flash', undefined)).toBe(true);
      expect(isModelAllowed('gemini-1.5-flash', [])).toBe(true);
    });

    it('isModelAllowed returns true only for models in allow-list', () => {
      const allowed = ['gemini-1.5-flash', 'gemini-3.6-flash'];
      expect(isModelAllowed('gemini-1.5-flash', allowed)).toBe(true);
      expect(isModelAllowed('gemini-3.6-flash', allowed)).toBe(true);
      expect(isModelAllowed('gemini-1.5-pro', allowed)).toBe(false);
      expect(isModelAllowed('gpt-4', allowed)).toBe(false);
    });

    it('isModelAllowed checks defaultModel when requestedModel is omitted', () => {
      const allowed = ['gemini-1.5-flash'];
      expect(isModelAllowed(undefined, allowed, 'gemini-1.5-flash')).toBe(true);
      expect(isModelAllowed(undefined, allowed, 'gemini-1.5-pro')).toBe(false);
    });

    it('isModelAllowed rejects empty or whitespace-only requestedModel', () => {
      const allowed = ['gemini-1.5-flash'];
      expect(isModelAllowed('', allowed, 'gemini-1.5-flash')).toBe(false);
      expect(isModelAllowed('   ', allowed, 'gemini-1.5-flash')).toBe(false);
    });

    it('isModelAllowed trims unexpected surrounding whitespace from model name', () => {
      const allowed = ['gemini-1.5-flash'];
      expect(isModelAllowed('  gemini-1.5-flash  ', allowed)).toBe(true);
      expect(isModelAllowed('\tgemini-1.5-flash\n', allowed)).toBe(true);
    });

    it('isModelAllowed is case-sensitive for model identifiers', () => {
      const allowed = ['gemini-1.5-flash'];
      expect(isModelAllowed('GEMINI-1.5-FLASH', allowed)).toBe(false);
      expect(isModelAllowed('Gemini-1.5-Flash', allowed)).toBe(false);
    });

    it('isMaxTokensExceeded returns false when limit is undefined or null', () => {
      expect(isMaxTokensExceeded(5000, undefined)).toBe(false);
      expect(isMaxTokensExceeded(5000, null as any)).toBe(false);
    });

    it('isMaxTokensExceeded returns true only when requested tokens strictly exceed limit', () => {
      expect(isMaxTokensExceeded(1000, 2000)).toBe(false);
      expect(isMaxTokensExceeded(2000, 2000)).toBe(false); // At limit
      expect(isMaxTokensExceeded(2001, 2000)).toBe(true);  // Above limit
      expect(isMaxTokensExceeded(undefined, 2000)).toBe(false);
    });

    it('isMaxTokensExceeded handles negative, zero, and non-numeric token edge cases', () => {
      expect(isMaxTokensExceeded(-10, 2000)).toBe(false);
      expect(isMaxTokensExceeded(0, 2000)).toBe(false);
      expect(isMaxTokensExceeded('abc', 2000)).toBe(false);
      expect(isMaxTokensExceeded(null, 2000)).toBe(false);
    });

    it('isMaxTokensExceeded parses string integer token counts', () => {
      expect(isMaxTokensExceeded('2001', 2000)).toBe(true);
      expect(isMaxTokensExceeded(' 2001 ', 2000)).toBe(true);
      expect(isMaxTokensExceeded('2000', 2000)).toBe(false);
      expect(isMaxTokensExceeded('1000', 2000)).toBe(false);
    });
  });

  describe('3. End-to-End Gateway Integration via buildServer', () => {
    function createMockServer(policyOptions: { allowedModels?: string[]; maxTokensLimit?: number }) {
      const mockCreateChatCompletion = vi.fn().mockResolvedValue({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1000,
        model: 'gemini-1.5-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'test response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });

      const mockPublish = vi.fn().mockResolvedValue({ success: true });

      const serverPromise = buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'test-gemini-key', model: 'gemini-1.5-flash' },
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
          createChatCompletion: mockCreateChatCompletion,
        },
        usagePublisher: {
          publish: mockPublish,
          close: vi.fn().mockResolvedValue(undefined),
        },
        policy: policyOptions,
      });

      return { serverPromise, mockCreateChatCompletion, mockPublish };
    }

    describe('Model Allow-List Policy', () => {
      it('allows requests using an explicitly allowed model', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          allowedModels: ['gemini-1.5-flash', 'gemini-3.6-flash'],
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: 'gemini-3.6-flash',
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('allows requests that omit model when defaultModel is in the allow-list', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('rejects requests using a disallowed model with HTTP 403 MODEL_NOT_ALLOWED without calling provider', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: 'gemini-1.5-pro',
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body).toEqual({
          error: 'Forbidden',
          message: "Model 'gemini-1.5-pro' is not allowed",
          code: 'MODEL_NOT_ALLOWED',
        });
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects requests that omit model when defaultModel is not in the allow-list', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          allowedModels: ['gemini-3.6-flash'], // defaultModel is gemini-1.5-flash
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('MODEL_NOT_ALLOWED');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects requests with empty string model with HTTP 403 MODEL_NOT_ALLOWED', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: '',
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('MODEL_NOT_ALLOWED');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('allows requests using a valid model that has surrounding whitespace (trimmed)', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: '  gemini-1.5-flash  ',
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('rejects requests where model casing differs from allow-list (case-sensitive)', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: 'GEMINI-1.5-FLASH',
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('MODEL_NOT_ALLOWED');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Maximum Output Tokens Ceiling Policy', () => {
      it('allows requests with max_tokens strictly below limit', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 1024,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('allows requests with max_tokens exactly at the limit', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 2048,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('allows requests that omit max_tokens', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('rejects requests with max_tokens strictly above limit with HTTP 400 MAX_TOKENS_EXCEEDED without calling provider', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 2049,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body).toEqual({
          error: 'Bad Request',
          message: 'Requested max_tokens (2049) exceeds maximum permitted limit of 2048',
          code: 'MAX_TOKENS_EXCEEDED',
        });
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('does not reject requests with negative or zero max_tokens with MAX_TOKENS_EXCEEDED', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: -10,
          },
        });

        // Negative max_tokens is rejected as invalid request, not max tokens exceeded
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(body.code).not.toBe('MAX_TOKENS_EXCEEDED');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects requests with string integer max_tokens exceeding limit with HTTP 400 MAX_TOKENS_EXCEEDED', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: '5000' as any,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('MAX_TOKENS_EXCEEDED');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Combined Policies & Precedence', () => {
      it('rejects with 403 MODEL_NOT_ALLOWED first when both model is disallowed and max_tokens is exceeded', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
          maxTokensLimit: 1000,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: 'unauthorized-model',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 5000,
          },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('MODEL_NOT_ALLOWED');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('allows request when both model is allowed and max_tokens is within limit', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
          maxTokensLimit: 2048,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            model: 'gemini-1.5-flash',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 2048,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });
    });

    describe('Body Edge Cases & Non-Object Payloads', () => {
      it('gracefully allows empty or malformed body payloads to fall through to standard route validation (400 INVALID_REQUEST)', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
          maxTokensLimit: 1000,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {},
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Public Endpoints Bypass', () => {
      it('bypasses /health check', async () => {
        const { serverPromise } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
          maxTokensLimit: 100,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'GET',
          url: '/health',
        });

        expect(res.statusCode).toBe(200);
        await app.close();
      });

      it('bypasses /metrics check', async () => {
        const { serverPromise } = createMockServer({
          allowedModels: ['gemini-1.5-flash'],
          maxTokensLimit: 100,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'GET',
          url: '/metrics',
        });

        expect(res.statusCode).toBe(200);
        await app.close();
      });
    });
  });
});
