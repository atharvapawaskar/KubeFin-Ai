import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { extractUsageMetadata, extractServedModel, createGeminiProvider } from '../src/providers/gemini.js';
import { createUsageEvent, UsageEvent } from '../src/events/usage-event.js';
import {
  RedisUsageEventPublisher,
  sanitizeErrorMessage,
  UsageEventPublisher,
  RedisClientLike,
} from '../src/events/redis-publisher.js';
import { buildServer } from '../src/index.js';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const contractPath = path.resolve(__dirname, '../../../contracts/events/usage-event.v1.json');
const contractSchema = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateContract = ajv.compile(contractSchema);

describe('Gateway Usage Event System', () => {
  const API_KEY = 'test-api-key-12345';
  const TENANT_ID = 'test-tenant';

  describe('1. Gemini usageMetadata mapping & token extraction', () => {
    it('should map promptTokenCount to inputTokens and candidatesTokenCount to outputTokens', () => {
      const mockResponse = {
        usageMetadata: {
          promptTokenCount: 1420,
          candidatesTokenCount: 385,
          totalTokenCount: 1805,
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeDefined();
      expect(usage?.inputTokens).toBe(1420);
      expect(usage?.outputTokens).toBe(385);
    });

    it('should accept outputTokens: 0 when explicitly reported by provider', () => {
      const mockResponse = {
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 0,
          totalTokenCount: 50,
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeDefined();
      expect(usage?.inputTokens).toBe(50);
      expect(usage?.outputTokens).toBe(0);
    });

    it('should return undefined when usageMetadata is missing completely (no character estimation)', () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: 'Some generated text' }] } }],
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeUndefined();
    });

    it('should return undefined when candidatesTokenCount is missing (never substitute zero for unknown)', () => {
      const mockResponse = {
        usageMetadata: {
          promptTokenCount: 50,
          // candidatesTokenCount omitted
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeUndefined();
    });

    it('should return undefined when promptTokenCount is missing', () => {
      const mockResponse = {
        usageMetadata: {
          candidatesTokenCount: 20,
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeUndefined();
    });

    it('should return undefined when tokens are negative or non-integers', () => {
      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: -5, candidatesTokenCount: 10 },
        })
      ).toBeUndefined();

      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: 10.5, candidatesTokenCount: 10 },
        })
      ).toBeUndefined();

      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: -1 },
        })
      ).toBeUndefined();
    });

    it('should sum candidatesTokenCount and thoughtsTokenCount into outputTokens when reasoning tokens are present', () => {
      const mockResponse = {
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 9,
          thoughtsTokenCount: 145,
          totalTokenCount: 155,
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeDefined();
      expect(usage?.inputTokens).toBe(1);
      expect(usage?.outputTokens).toBe(154);
    });

    it('should accept thoughtsTokenCount: 0 and compute outputTokens correctly without double counting', () => {
      const mockResponse = {
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 0,
          totalTokenCount: 70,
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeDefined();
      expect(usage?.inputTokens).toBe(50);
      expect(usage?.outputTokens).toBe(20);
    });

    it('should preserve existing behavior when thoughtsTokenCount is omitted or undefined', () => {
      const mockResponse = {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 40,
        },
      };

      const usage = extractUsageMetadata(mockResponse);
      expect(usage).toBeDefined();
      expect(usage?.inputTokens).toBe(100);
      expect(usage?.outputTokens).toBe(40);
    });

    it('should return undefined when thoughtsTokenCount is negative, non-integer, or invalid', () => {
      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: -1 },
        })
      ).toBeUndefined();

      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 15.5 },
        })
      ).toBeUndefined();

      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 'invalid' as any },
        })
      ).toBeUndefined();

      expect(
        extractUsageMetadata({
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: NaN },
        })
      ).toBeUndefined();
    });

    it('should return undefined when the sum of candidatesTokenCount and thoughtsTokenCount exceeds Number.MAX_SAFE_INTEGER', () => {
      expect(
        extractUsageMetadata({
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: Number.MAX_SAFE_INTEGER,
            thoughtsTokenCount: 1,
          },
        })
      ).toBeUndefined();

      expect(
        extractUsageMetadata({
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: Number.MAX_SAFE_INTEGER - 10,
            thoughtsTokenCount: 20,
          },
        })
      ).toBeUndefined();
    });
  });

  describe('1b. Gemini served-model extraction (extractServedModel)', () => {
    it('should use served modelVersion when present and different from requested model', () => {
      const mockResponse = {
        modelVersion: 'gemini-3.8-flash',
        candidates: [],
      };
      const served = extractServedModel(mockResponse, 'gemini-3.7-flash');
      expect(served).toBe('gemini-3.8-flash');
    });

    it('should trim whitespace from modelVersion', () => {
      const mockResponse = {
        modelVersion: '  gemini-3.8-flash  ',
      };
      const served = extractServedModel(mockResponse, 'gemini-3.7-flash');
      expect(served).toBe('gemini-3.8-flash');
    });

    it('should fall back to requested model when modelVersion is missing', () => {
      const mockResponse = {
        candidates: [],
      };
      const served = extractServedModel(mockResponse, 'gemini-1.5-flash');
      expect(served).toBe('gemini-1.5-flash');
    });

    it('should fall back to requested model when modelVersion is empty or whitespace-only', () => {
      expect(extractServedModel({ modelVersion: '' }, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(extractServedModel({ modelVersion: '   ' }, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
    });

    it('should fall back to requested model when modelVersion is invalid (non-string)', () => {
      expect(extractServedModel({ modelVersion: 123 }, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(extractServedModel({ modelVersion: null }, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(extractServedModel({ modelVersion: true }, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(extractServedModel({ modelVersion: {} }, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
    });

    it('should fall back to requested model when response is null, undefined, or primitive', () => {
      expect(extractServedModel(null, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(extractServedModel(undefined, 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(extractServedModel('non-object', 'gemini-1.5-flash')).toBe('gemini-1.5-flash');
    });
  });

  describe('2. Contract compliance and event factory', () => {
    it('should create an event matching contracts/events/usage-event.v1.json', () => {
      const event = createUsageEvent({
        tenantId: 'acme-corp',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        inputTokens: 120,
        outputTokens: 45,
        requestId: 'req-001',
        teamId: 'infra-team',
        workloadId: 'k8s-worker-1',
      });

      // Must be valid according to contract JSON schema
      const isValid = validateContract(event);
      expect(isValid, JSON.stringify(validateContract.errors)).toBe(true);

      // Verify required fields
      expect(event.schemaVersion).toBe(1);
      expect(event.provider).toBe('gemini');
      expect(event.model).toBe('gemini-1.5-flash');
      expect(event.tenantId).toBe('acme-corp');
      expect(event.usage).toEqual({ inputTokens: 120, outputTokens: 45 });

      // Verify UUID format for eventId
      expect(event.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );

      // Verify UTC timestamp ending in Z
      expect(event.occurredAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
      );
      expect(event.occurredAt.endsWith('Z')).toBe(true);

      // Verify optional fields
      expect(event.requestId).toBe('req-001');
      expect(event.teamId).toBe('infra-team');
      expect(event.workloadId).toBe('k8s-worker-1');
    });

    it('should omit optional fields rather than sending null or empty strings', () => {
      const event = createUsageEvent({
        tenantId: 'acme-corp',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        inputTokens: 10,
        outputTokens: 0,
      });

      const isValid = validateContract(event);
      expect(isValid).toBe(true);

      expect(event).not.toHaveProperty('requestId');
      expect(event).not.toHaveProperty('teamId');
      expect(event).not.toHaveProperty('workloadId');

      // Verify forbidden fields are not present
      expect(event).not.toHaveProperty('cost');
      expect(event).not.toHaveProperty('currency');
      expect(event).not.toHaveProperty('totalTokens');
      expect(event).not.toHaveProperty('promptTokens');
      expect(event).not.toHaveProperty('completionTokens');
    });

    it('should reject invalid token bounds or missing required identifiers', () => {
      expect(() =>
        createUsageEvent({
          tenantId: 'acme',
          provider: 'gemini',
          model: 'm',
          inputTokens: -1,
          outputTokens: 10,
        })
      ).toThrow(/inputTokens/);

      expect(() =>
        createUsageEvent({
          tenantId: '',
          provider: 'gemini',
          model: 'm',
          inputTokens: 10,
          outputTokens: 10,
        })
      ).toThrow(/tenantId/);
    });
  });

  describe('3. Redis Stream Publishing & Serialization', () => {
    it('should publish to Redis Stream usage-events with field payload containing serialized JSON', async () => {
      const xAddMock = vi.fn().mockResolvedValue('1729000000000-0');
      const mockClient: RedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        xAdd: xAddMock,
        on: vi.fn(),
      };

      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        stream: 'usage-events',
        client: mockClient,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const event = createUsageEvent({
        tenantId: 'test-tenant',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        inputTokens: 100,
        outputTokens: 25,
      });

      const result = await publisher.publish(event);

      expect(result.success).toBe(true);
      expect(result.entryId).toBe('1729000000000-0');

      // Verify Redis stream and field
      expect(xAddMock).toHaveBeenCalledTimes(1);
      const [streamArg, idArg, fieldsArg] = xAddMock.mock.calls[0];
      expect(streamArg).toBe('usage-events');
      expect(idArg).toBe('*');
      expect(fieldsArg).toHaveProperty('payload');

      // Verify payload is valid JSON and parses to the exact event
      const parsedPayload = JSON.parse(fieldsArg.payload);
      expect(parsedPayload).toEqual(event);
      expect(validateContract(parsedPayload)).toBe(true);
    });

    it('should reuse the exact same eventId across Redis publishing retries', async () => {
      let attempts = 0;
      const recordedPayloads: string[] = [];

      const xAddMock = vi.fn().mockImplementation((_stream, _id, fields) => {
        attempts++;
        recordedPayloads.push(fields.payload);
        if (attempts < 3) {
          return Promise.reject(new Error('Connection timed out'));
        }
        return Promise.resolve('1729000000000-1');
      });

      const mockClient: RedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        xAdd: xAddMock,
        on: vi.fn(),
      };

      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        stream: 'usage-events',
        maxRetries: 3,
        retryDelayMs: 10,
        client: mockClient,
        logger: mockLogger,
      });

      const event = createUsageEvent({
        tenantId: 'test-tenant',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        inputTokens: 200,
        outputTokens: 50,
      });

      const result = await publisher.publish(event);

      expect(result.success).toBe(true);
      expect(xAddMock).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);

      // Ensure every attempt used the exact same eventId
      expect(recordedPayloads.length).toBe(3);
      for (const payloadStr of recordedPayloads) {
        const parsed = JSON.parse(payloadStr);
        expect(parsed.eventId).toBe(event.eventId);
      }
    });

    it('should handle Redis publishing failure without throwing, and return failure status', async () => {
      const xAddMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const mockClient: RedisClientLike = {
        isOpen: true,
        connect: vi.fn().mockResolvedValue(undefined),
        xAdd: xAddMock,
        on: vi.fn(),
      };

      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const publisher = new RedisUsageEventPublisher({
        url: 'redis://localhost:6379',
        maxRetries: 2,
        retryDelayMs: 5,
        client: mockClient,
        logger: mockLogger,
      });

      const event = createUsageEvent({
        tenantId: 'test-tenant',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        inputTokens: 50,
        outputTokens: 10,
      });

      const result = await publisher.publish(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      expect(xAddMock).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });

    it('should sanitize credentials in error logs', () => {
      const errWithRedisAuth = new Error(
        'connect ECONNREFUSED redis://default:supersecretpassword@127.0.0.1:6379'
      );
      const sanitized = sanitizeErrorMessage(errWithRedisAuth);
      expect(sanitized).not.toContain('supersecretpassword');
      expect(sanitized).toContain('redis://default:***@127.0.0.1:6379');

      const errWithBearer = new Error('Unauthorized for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      const sanitizedBearer = sanitizeErrorMessage(errWithBearer);
      expect(sanitizedBearer).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(sanitizedBearer).toContain('Bearer ***');
    });
  });

  describe('4. Gateway Integration: End-to-End Chat & Usage Publishing', () => {
    let mockPublisher: {
      publish: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    let mockGeminiProvider: {
      createChatCompletion: ReturnType<typeof vi.fn>;
      defaultModel: string;
    };
    let app: any;

    beforeEach(async () => {
      mockPublisher = {
        publish: vi.fn().mockResolvedValue({ success: true, entryId: '1-0' }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockGeminiProvider = {
        defaultModel: 'gemini-1.5-flash',
        createChatCompletion: vi.fn(),
      };

      app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'mock-gemini-key', model: 'gemini-1.5-flash' },
          redis: {
            url: 'redis://localhost:6379',
            stream: 'usage-events',
            enabled: true,
            maxRetries: 3,
            retryDelayMs: 10,
          },
        },
        geminiProvider: mockGeminiProvider as any,
        usagePublisher: mockPublisher as any,
      });

      await app.ready();
    });

    afterEach(async () => {
      await app.close();
      vi.clearAllMocks();
    });

    it('should emit a valid usage event when trustworthy usage metadata is returned', async () => {
      mockGeminiProvider.createChatCompletion.mockResolvedValue({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response with usage' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'x-request-id': 'custom-req-999',
          'x-team-id': 'data-science',
          'x-workload-id': 'model-evaluator',
        },
        payload: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);

      const publishedEvent: UsageEvent = mockPublisher.publish.mock.calls[0][0];
      expect(publishedEvent.tenantId).toBe(TENANT_ID);
      expect(publishedEvent.provider).toBe('gemini');
      expect(publishedEvent.model).toBe('gemini-1.5-flash');
      expect(publishedEvent.usage.inputTokens).toBe(42);
      expect(publishedEvent.usage.outputTokens).toBe(18);
      expect(publishedEvent.requestId).toBe('custom-req-999');
      expect(publishedEvent.teamId).toBe('data-science');
      expect(publishedEvent.workloadId).toBe('model-evaluator');

      // Verify contract conformance
      expect(validateContract(publishedEvent)).toBe(true);
    });

    it('should NOT emit a usage event when usage metadata is missing', async () => {
      mockGeminiProvider.createChatCompletion.mockResolvedValue({
        id: 'chatcmpl-no-usage',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'No usage metadata here' },
            finish_reason: 'stop',
          },
        ],
        // usage is omitted
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.usage).toBeUndefined();

      // Crucial: no event emitted
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('should NOT emit a usage event on policy or client rejection (400, 401)', async () => {
      // 401 Missing auth
      const authResponse = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });
      expect(authResponse.statusCode).toBe(401);
      expect(mockPublisher.publish).not.toHaveBeenCalled();

      // 400 Bad request
      const badReqResponse = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [] },
      });
      expect(badReqResponse.statusCode).toBe(400);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('should still return 200 chat completion when Redis publishing fails', async () => {
      mockPublisher.publish.mockResolvedValue({
        success: false,
        error: 'ECONNREFUSED: Connection refused',
      });

      mockGeminiProvider.createChatCompletion.mockResolvedValue({
        id: 'chatcmpl-redis-down',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Service continues to operate' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      // HTTP response must not fail or crash
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.choices[0].message.content).toBe('Service continues to operate');

      // Publish was attempted
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('should emit usage event and completion response with served model when provider returns a different model than requested', async () => {
      mockGeminiProvider.createChatCompletion.mockResolvedValue({
        id: 'chatcmpl-served-model-test',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-3.8-flash', // Google served gemini-3.8-flash
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Routed to replacement model' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 35, total_tokens: 50 },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: {
          model: 'gemini-3.7-flash', // Client requested alias
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      // Response model must be the served model
      expect(body.model).toBe('gemini-3.8-flash');

      // Published usage event must also carry the served model
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedEvent: UsageEvent = mockPublisher.publish.mock.calls[0][0];
      expect(publishedEvent.model).toBe('gemini-3.8-flash');
      expect(validateContract(publishedEvent)).toBe(true);
    });
  });
});
