import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { createAuthMiddleware } from '../src/middleware/auth.js';
import { createGeminiProvider, ChatCompletionRequest } from '../src/providers/gemini.js';

const API_KEY = 'test-api-key-12345';
const TENANT_ID = 'test-tenant';

// Mock Gemini provider
const mockCreateChatCompletion = vi.fn();
const mockGeminiProvider = {
  createChatCompletion: mockCreateChatCompletion,
};

vi.mock('../src/providers/gemini.js', () => ({
  createGeminiProvider: vi.fn(() => mockGeminiProvider),
}));

describe('Chat Completions Endpoint', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Add auth middleware
    app.addHook('onRequest', createAuthMiddleware({
      apiKey: API_KEY,
      tenantId: TENANT_ID,
      skipPaths: ['/health'],
    }));

    // Public endpoint
    app.get('/health', async () => ({ status: 'ok' }));

    // Protected test-auth endpoint
    app.get('/v1/test-auth', async (request: FastifyRequest) => ({
      authenticated: true,
      tenantId: request.user?.tenantId,
      apiKeyPrefix: request.user?.apiKeyPrefix,
    }));

    // Chat completions endpoint (will use mocked provider)
    app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ChatCompletionRequest;

      if (!body || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'messages array is required and must not be empty',
          code: 'INVALID_REQUEST',
        });
      }

      for (const msg of body.messages) {
        if (!msg.role || !['system', 'user', 'assistant'].includes(msg.role)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Each message must have a valid role (system, user, or assistant)',
            code: 'INVALID_MESSAGE_ROLE',
          });
        }
        if (typeof msg.content !== 'string') {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Each message must have a string content',
            code: 'INVALID_MESSAGE_CONTENT',
          });
        }
      }

      if (body.stream === true) {
        return reply.code(501).send({
          error: 'Not Implemented',
          message: 'Streaming is not supported yet',
          code: 'STREAMING_NOT_SUPPORTED',
        });
      }

      try {
        const completion = await mockGeminiProvider.createChatCompletion(body);
        return completion;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';

        const isTimeout =
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
          errorMessage.includes('aborted') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('timed out');

        if (isTimeout) {
          return reply.code(504).send({
            error: 'Gateway Timeout',
            message: 'Provider timeout: The upstream provider request timed out',
            code: 'PROVIDER_TIMEOUT',
          });
        }

        if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('quota')) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Provider rate limit exceeded. Please try again later.',
            code: 'PROVIDER_RATE_LIMIT',
          });
        }

        if (errorMessage.includes('401') || errorMessage.includes('unauthorized') || errorMessage.includes('invalid api key')) {
          return reply.code(502).send({
            error: 'Bad Gateway',
            message: 'Invalid provider API key configuration',
            code: 'PROVIDER_AUTH_ERROR',
          });
        }

        return reply.code(502).send({
          error: 'Bad Gateway',
          message: 'Provider error: The upstream provider encountered an error while processing the request',
          code: 'PROVIDER_ERROR',
        });
      }
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  const validAuthHeaders = { authorization: `Bearer ${API_KEY}` };

  describe('Authentication', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('MISSING_AUTH_HEADER');
    });

    it('should return 401 when API key is invalid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer wrong-key' },
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('INVALID_API_KEY');
    });
  });

  describe('Request Validation', () => {
    it('should return 400 when messages array is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('should return 400 when messages array is empty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [] },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('should return 400 when message role is invalid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'invalid', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('INVALID_MESSAGE_ROLE');
    });

    it('should return 400 when message content is not a string', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 123 }] },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('INVALID_MESSAGE_CONTENT');
    });

    it('should return 501 when streaming is requested', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hello' }], stream: true },
      });

      expect(response.statusCode).toBe(501);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('STREAMING_NOT_SUPPORTED');
    });
  });

  describe('Successful Response', () => {
    beforeEach(() => {
      mockCreateChatCompletion.mockReset();
    });

    it('should return 200 with OpenAI-compatible response on success', async () => {
      const mockResponse = {
        id: 'chatcmpl-test123',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello! How can I help?' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      mockCreateChatCompletion.mockResolvedValue(mockResponse);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: {
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Say hello' },
          ],
          temperature: 0.7,
          max_tokens: 100,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.id).toBe('chatcmpl-test123');
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.usage.total_tokens).toBe(15);
    });

    it('should work with minimal request (just messages)', async () => {
      const mockResponse = {
        id: 'chatcmpl-minimal',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hi there!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };
      mockCreateChatCompletion.mockResolvedValue(mockResponse);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hi' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.choices[0].message.content).toBe('Hi there!');
    });
  });

  describe('Provider Error Handling', () => {
    beforeEach(() => {
      mockCreateChatCompletion.mockReset();
    });

    it('should return 429 on provider rate limit error', async () => {
      mockCreateChatCompletion.mockRejectedValue(new Error('429 rate limit exceeded'));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('PROVIDER_RATE_LIMIT');
    });

    it('should return 502 on provider auth error', async () => {
      mockCreateChatCompletion.mockRejectedValue(new Error('401 invalid api key'));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('PROVIDER_AUTH_ERROR');
    });

    it('should return 502 on generic provider error', async () => {
      mockCreateChatCompletion.mockRejectedValue(new Error('Internal server error'));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('PROVIDER_ERROR');
    });

    it('should return 504 on provider timeout / abort error', async () => {
      mockCreateChatCompletion.mockRejectedValue(new Error('This operation was aborted'));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(504);
      const body = JSON.parse(response.payload);
      expect(body.code).toBe('PROVIDER_TIMEOUT');
      expect(body.error).toBe('Gateway Timeout');
      expect(body.message).toBe('Provider timeout: The upstream provider request timed out');
    });
  });

  describe('Edge Cases - Empty/Blocked Responses', () => {
    beforeEach(() => {
      mockCreateChatCompletion.mockReset();
    });

    it('should return 200 with empty content and content_filter finish_reason when response blocked by safety', async () => {
      const mockResponse = {
        id: 'chatcmpl-safety-block',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'content_filter',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      };
      mockCreateChatCompletion.mockResolvedValue(mockResponse);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Trigger safety filter' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.choices[0].message.content).toBe('');
      expect(body.choices[0].finish_reason).toBe('content_filter');
      expect(body.usage.completion_tokens).toBe(0);
    });

    it('should return 200 with empty content and empty_response finish_reason when response is empty', async () => {
      const mockResponse = {
        id: 'chatcmpl-empty',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'empty_response',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      };
      mockCreateChatCompletion.mockResolvedValue(mockResponse);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.choices[0].message.content).toBe('');
      expect(body.choices[0].finish_reason).toBe('empty_response');
      expect(body.usage.completion_tokens).toBe(0);
    });

    it('should return 200 with length finish_reason when response truncated by max_tokens', async () => {
      const mockResponse = {
        id: 'chatcmpl-length',
        object: 'chat.completion',
        created: 1699900000,
        model: 'gemini-1.5-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Partial response...' },
          finish_reason: 'length',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
      };
      mockCreateChatCompletion.mockResolvedValue(mockResponse);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: validAuthHeaders,
        payload: { messages: [{ role: 'user', content: 'Write a very long story' }], max_tokens: 50 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.choices[0].finish_reason).toBe('length');
      expect(body.choices[0].message.content).toBe('Partial response...');
    });
  });
});