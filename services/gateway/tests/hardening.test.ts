import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { loadMaxPayloadBytesConfig, DEFAULT_MAX_PAYLOAD_BYTES } from '../src/config.js';
import {
  DEFAULT_MAX_JSON_DEPTH,
  isExcessiveNesting,
  validateInboundHeader,
  validateTokenCount,
  validateTemperature,
} from '../src/security.js';

const API_KEY = 'test-hardening-key-12345';
const TENANT_ID = 'test-hardening-tenant';

describe('Gateway Security & Payload Hardening (Task 4.2)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('1. Configuration & Validation (loadMaxPayloadBytesConfig)', () => {
    it('returns default 1 MiB (1048576 bytes) when GATEWAY_MAX_PAYLOAD_BYTES is unset', () => {
      delete process.env.GATEWAY_MAX_PAYLOAD_BYTES;
      expect(loadMaxPayloadBytesConfig()).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
      expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(1048576);
    });

    it('parses valid positive integer GATEWAY_MAX_PAYLOAD_BYTES', () => {
      process.env.GATEWAY_MAX_PAYLOAD_BYTES = '2097152'; // 2 MiB
      expect(loadMaxPayloadBytesConfig()).toBe(2097152);

      process.env.GATEWAY_MAX_PAYLOAD_BYTES = ' 524288 '; // 512 KiB with whitespace
      expect(loadMaxPayloadBytesConfig()).toBe(524288);
    });

    it('rejects non-numeric, decimal, negative, or zero GATEWAY_MAX_PAYLOAD_BYTES', () => {
      process.env.GATEWAY_MAX_PAYLOAD_BYTES = 'abc';
      expect(() => loadMaxPayloadBytesConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_PAYLOAD_BYTES = '1048576.5';
      expect(() => loadMaxPayloadBytesConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_PAYLOAD_BYTES = '0';
      expect(() => loadMaxPayloadBytesConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_PAYLOAD_BYTES = '-1048576';
      expect(() => loadMaxPayloadBytesConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);

      process.env.GATEWAY_MAX_PAYLOAD_BYTES = '2147483648';
      expect(() => loadMaxPayloadBytesConfig()).toThrow(/must be a positive integer between 1 and 2147483647/);
    });
  });

  describe('2. Pure Security Helper Unit Tests', () => {
    describe('isExcessiveNesting', () => {
      it('returns false for primitives, null, and shallow structures', () => {
        expect(isExcessiveNesting(null)).toBe(false);
        expect(isExcessiveNesting('hello')).toBe(false);
        expect(isExcessiveNesting(123)).toBe(false);
        expect(isExcessiveNesting({ a: 1, b: 'two' })).toBe(false);
        expect(isExcessiveNesting([{ role: 'user', content: 'hi' }])).toBe(false);
      });

      it('returns false for structures at or below maxDepth', () => {
        // Build an object with depth exactly 5
        let obj: any = 'leaf';
        for (let i = 0; i < 5; i++) {
          obj = { child: obj };
        }
        expect(isExcessiveNesting(obj, 5)).toBe(false);
        expect(isExcessiveNesting(obj, 10)).toBe(false);
      });

      it('returns true when nesting strictly exceeds maxDepth', () => {
        let obj: any = 'leaf';
        for (let i = 0; i < 35; i++) {
          obj = { child: obj };
        }
        expect(isExcessiveNesting(obj, 32)).toBe(true);
      });

      it('handles nested arrays properly', () => {
        let arr: any = ['leaf'];
        for (let i = 0; i < 35; i++) {
          arr = [arr];
        }
        expect(isExcessiveNesting(arr, 32)).toBe(true);
      });
    });

    describe('validateInboundHeader', () => {
      it('returns valid when header is undefined', () => {
        expect(validateInboundHeader('x-request-id', undefined)).toEqual({ valid: true });
      });

      it('returns valid and trims valid header strings', () => {
        const res = validateInboundHeader('x-request-id', '  req-12345-abc  ');
        expect(res.valid).toBe(true);
        expect(res.value).toBe('req-12345-abc');
      });

      it('rejects non-string header values', () => {
        const res = validateInboundHeader('x-request-id', 12345 as any);
        expect(res.valid).toBe(false);
        expect(res.error).toContain('x-request-id');
      });

      it('rejects empty or whitespace-only header values', () => {
        expect(validateInboundHeader('x-request-id', '').valid).toBe(false);
        expect(validateInboundHeader('x-team-id', '   ').valid).toBe(false);
      });

      it('rejects header values exceeding 256 characters', () => {
        const longHeader = 'a'.repeat(257);
        const res = validateInboundHeader('x-workload-id', longHeader);
        expect(res.valid).toBe(false);
        expect(res.error).toContain('x-workload-id');
      });

      it('rejects headers with ASCII control characters or CRLF injection', () => {
        expect(validateInboundHeader('x-request-id', 'req\r\ninjected').valid).toBe(false);
        expect(validateInboundHeader('x-request-id', 'req\0admin').valid).toBe(false);
        expect(validateInboundHeader('x-team-id', 'team\x1b[31m').valid).toBe(false);
      });
    });

    describe('validateTokenCount', () => {
      it('returns valid when max_tokens is undefined', () => {
        expect(validateTokenCount(undefined)).toEqual({ valid: true });
      });

      it('returns valid for positive safe integers', () => {
        expect(validateTokenCount(1)).toEqual({ valid: true });
        expect(validateTokenCount(100)).toEqual({ valid: true });
        expect(validateTokenCount(2048)).toEqual({ valid: true });
      });

      it('rejects negative numbers, zero, floats, and non-numbers', () => {
        expect(validateTokenCount(-1).valid).toBe(false);
        expect(validateTokenCount(0).valid).toBe(false);
        expect(validateTokenCount(10.5).valid).toBe(false);
        expect(validateTokenCount('100').valid).toBe(false);
        expect(validateTokenCount(NaN).valid).toBe(false);
        expect(validateTokenCount(Infinity).valid).toBe(false);
        expect(validateTokenCount(null).valid).toBe(false);
      });
    });

    describe('validateTemperature', () => {
      it('returns valid when temperature is undefined', () => {
        expect(validateTemperature(undefined)).toEqual({ valid: true });
      });

      it('returns valid for numbers between 0 and 2', () => {
        expect(validateTemperature(0)).toEqual({ valid: true });
        expect(validateTemperature(0.7)).toEqual({ valid: true });
        expect(validateTemperature(2)).toEqual({ valid: true });
      });

      it('rejects numbers outside [0, 2] and non-numbers', () => {
        expect(validateTemperature(-0.1).valid).toBe(false);
        expect(validateTemperature(2.1).valid).toBe(false);
        expect(validateTemperature(NaN).valid).toBe(false);
        expect(validateTemperature('0.7').valid).toBe(false);
      });
    });
  });

  describe('3. End-to-End Gateway Integration via buildServer', () => {
    function createMockServer(options?: {
      maxPayloadBytes?: number;
      allowedModels?: string[];
      maxTokensLimit?: number;
    }) {
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
          policy: {
            allowedModels: options?.allowedModels,
            maxTokensLimit: options?.maxTokensLimit,
          },
        },
        maxPayloadBytes: options?.maxPayloadBytes,
        geminiProvider: {
          defaultModel: 'gemini-1.5-flash',
          createChatCompletion: mockCreateChatCompletion,
        },
        usagePublisher: {
          publish: mockPublish,
          close: vi.fn().mockResolvedValue(undefined),
        },
      });

      return { serverPromise, mockCreateChatCompletion, mockPublish };
    }

    describe('Payload Size Limit (HTTP 413 PAYLOAD_TOO_LARGE)', () => {
      it('allows request with payload size strictly below limit', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          maxPayloadBytes: 1024, // 1 KiB limit
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
            messages: [{ role: 'user', content: 'small payload' }],
          },
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it('rejects request with payload size exceeding limit with HTTP 413 PAYLOAD_TOO_LARGE', async () => {
        const limit = 500;
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          maxPayloadBytes: limit,
        });
        const app = await serverPromise;

        const oversizedContent = 'x'.repeat(600);
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: oversizedContent }],
          },
        });

        expect(res.statusCode).toBe(413);
        const body = JSON.parse(res.body);
        expect(body).toEqual({
          error: 'Payload Too Large',
          message: `Request body exceeds maximum permitted size of ${limit} bytes`,
          code: 'PAYLOAD_TOO_LARGE',
        });
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('allows request with payload size exactly at boundary', async () => {
        // Construct exact JSON string length
        const basePayload = JSON.stringify({ messages: [{ role: 'user', content: 'padding' }] });
        const targetLen = Buffer.byteLength(basePayload, 'utf8');

        const { serverPromise, mockCreateChatCompletion } = createMockServer({
          maxPayloadBytes: targetLen,
        });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: basePayload,
        });

        expect(res.statusCode).toBe(200);
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(1);
        await app.close();
      });
    });

    describe('Malformed JSON & Parsing Security (HTTP 400 INVALID_JSON)', () => {
      it('rejects broken/invalid JSON syntax with HTTP 400 INVALID_JSON', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: '{"messages": [{"role": "user", "content": broken json',
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_JSON');
        expect(body.error).toBe('Bad Request');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects prototype poisoning (__proto__) with HTTP 400 INVALID_JSON', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: '{"__proto__": {"admin": true}, "messages": [{"role": "user", "content": "hi"}]}',
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_JSON');
        expect(body.message).toContain('forbidden prototype property');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects constructor poisoning (constructor.prototype) with HTTP 400 INVALID_JSON', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: '{"constructor": {"prototype": {"admin": true}}, "messages": [{"role": "user", "content": "hi"}]}',
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_JSON');
        expect(body.message).toContain('forbidden prototype property');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Excessive JSON Nesting Protections (HTTP 400 EXCESSIVE_NESTING)', () => {
      it('rejects requests exceeding maximum JSON nesting depth with HTTP 400 EXCESSIVE_NESTING', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          maxPayloadBytes: 1048576,
        });
        const app = await serverPromise;

        // Build 40 levels of nesting (limit is 32)
        let nestedObj: any = { role: 'user', content: 'deep' };
        for (let i = 0; i < 40; i++) {
          nestedObj = { nested: nestedObj };
        }

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
            extra: nestedObj,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('EXCESSIVE_NESTING');
        expect(body.message).toContain('nesting depth');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('handles parser-crashing deep recursion (5,000 levels) gracefully with HTTP 400 EXCESSIVE_NESTING without 500 error', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer({
          maxPayloadBytes: 1048576,
        });
        const app = await serverPromise;

        let deepPayload = '1';
        for (let i = 0; i < 5000; i++) {
          deepPayload = '{"a":' + deepPayload + '}';
        }

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: deepPayload,
        });

        // Must return 400 instead of crashing Fastify with HTTP 500
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('EXCESSIVE_NESTING');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Inbound Header Sanitization (HTTP 400 INVALID_HEADER)', () => {
      it('rejects headers with CRLF injection characters', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
            'x-request-id': 'req-123\r\ninjected-header: bad',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_HEADER');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects headers with null bytes', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
            'x-team-id': 'team\0admin',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_HEADER');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Token Count & Parameter Bounds (HTTP 400 INVALID_REQUEST)', () => {
      it('rejects negative max_tokens with HTTP 400 INVALID_REQUEST without calling provider', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: -10,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(body.message).toContain('max_tokens must be a positive integer');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        expect(mockPublish).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects zero max_tokens with HTTP 400 INVALID_REQUEST', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 0,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects float max_tokens with HTTP 400 INVALID_REQUEST', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 10.5,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects non-numeric max_tokens with HTTP 400 INVALID_REQUEST', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: '100' as any,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });

      it('rejects out-of-range temperature (< 0 or > 2) with HTTP 400 INVALID_REQUEST', async () => {
        const { serverPromise, mockCreateChatCompletion, mockPublish } = createMockServer();
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
            temperature: 2.5,
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('INVALID_REQUEST');
        expect(body.message).toContain('temperature');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });

    describe('Public Endpoints Bypass & Auth Precedence', () => {
      it('allows GET /health without payload limit or security interference', async () => {
        const { serverPromise } = createMockServer({ maxPayloadBytes: 50 });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'GET',
          url: '/health',
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).status).toBe('ok');
        await app.close();
      });

      it('enforces authentication before route handling', async () => {
        const { serverPromise, mockCreateChatCompletion } = createMockServer({ maxPayloadBytes: 50 });
        const app = await serverPromise;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
          },
          payload: {
            messages: [{ role: 'user', content: 'test' }],
          },
        });

        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('MISSING_AUTH_HEADER');
        expect(mockCreateChatCompletion).toHaveBeenCalledTimes(0);
        await app.close();
      });
    });
  });
});
