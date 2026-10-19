import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  buildServer,
  ProviderRouter,
  createOpenAIProvider,
  createAnthropicProvider,
  createOllamaProvider,
  createGeminiProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderAdapter,
} from '../src/index.js';
import { createUsageEvent } from '../src/events/usage-event.js';
import { UsageEventPublisher, PublishResult } from '../src/events/redis-publisher.js';

describe('Task 4.3: Multi-Provider Adapter Extension', () => {
  const API_KEY = 'test-api-key-multiprovider';
  const TENANT_ID = 'test-tenant-mp';

  // ──────────────────────────────────────────────────────────────────────────
  // 1. ProviderRouter Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. ProviderRouter', () => {
    let router: ProviderRouter;
    let mockGemini: ProviderAdapter;
    let mockOpenAI: ProviderAdapter;
    let mockAnthropic: ProviderAdapter;
    let mockOllama: ProviderAdapter;

    beforeEach(() => {
      mockGemini = {
        providerName: 'gemini',
        defaultModel: 'gemini-1.5-flash',
        createChatCompletion: vi.fn(),
      };
      mockOpenAI = {
        providerName: 'openai',
        defaultModel: 'gpt-4o',
        createChatCompletion: vi.fn(),
      };
      mockAnthropic = {
        providerName: 'anthropic',
        defaultModel: 'claude-3-5-sonnet-20241022',
        createChatCompletion: vi.fn(),
      };
      mockOllama = {
        providerName: 'ollama',
        defaultModel: 'llama3',
        createChatCompletion: vi.fn(),
      };

      router = new ProviderRouter({ defaultProvider: 'gemini' });
      router.register(mockGemini);
      router.register(mockOpenAI);
      router.register(mockAnthropic);
      router.register(mockOllama);
    });

    it('routes explicit prefix notation correctly', () => {
      const openAiRes = router.resolve('openai/gpt-4o-mini');
      expect(openAiRes).toBeDefined();
      expect(openAiRes?.providerName).toBe('openai');
      expect(openAiRes?.effectiveModel).toBe('gpt-4o-mini');

      const anthropicRes = router.resolve('anthropic/claude-3-haiku');
      expect(anthropicRes).toBeDefined();
      expect(anthropicRes?.providerName).toBe('anthropic');
      expect(anthropicRes?.effectiveModel).toBe('claude-3-haiku');

      const ollamaRes = router.resolve('ollama/mistral:instruct');
      expect(ollamaRes).toBeDefined();
      expect(ollamaRes?.providerName).toBe('ollama');
      expect(ollamaRes?.effectiveModel).toBe('mistral:instruct');

      const geminiRes = router.resolve('gemini/gemini-1.5-pro');
      expect(geminiRes).toBeDefined();
      expect(geminiRes?.providerName).toBe('gemini');
      expect(geminiRes?.effectiveModel).toBe('gemini-1.5-pro');
    });

    it('routes bare model names by pattern', () => {
      expect(router.resolve('gpt-4o')?.providerName).toBe('openai');
      expect(router.resolve('o1-preview')?.providerName).toBe('openai');
      expect(router.resolve('o3-mini')?.providerName).toBe('openai');
      expect(router.resolve('claude-3-5-sonnet-20241022')?.providerName).toBe('anthropic');
      expect(router.resolve('gemini-1.5-flash')?.providerName).toBe('gemini');
      expect(router.resolve('gemini-3.6-flash')?.providerName).toBe('gemini');
      expect(router.resolve('llama3')?.providerName).toBe('ollama');
      expect(router.resolve('mistral-7b')?.providerName).toBe('ollama');
      expect(router.resolve('deepseek-coder')?.providerName).toBe('ollama');
      expect(router.resolve('qwen-2.5')?.providerName).toBe('ollama');
    });

    it('routes omitted or empty model to default provider', () => {
      const res = router.resolve();
      expect(res).toBeDefined();
      expect(res?.providerName).toBe('gemini');
      expect(res?.effectiveModel).toBe('gemini-1.5-flash');

      const emptyRes = router.resolve('  ');
      expect(emptyRes?.providerName).toBe('gemini');
    });

    it('returns undefined for unsupported models when all providers are registered', () => {
      const res = router.resolve('some-unknown-unsupported-model-xyz');
      expect(res).toBeUndefined();
    });

    it('returns undefined for non-existent provider prefix', () => {
      const res = router.resolve('cohere/command-r');
      expect(res).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. OpenAI Provider Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. OpenAI Provider', () => {
    it('throws error when OPENAI_API_KEY is missing', async () => {
      const provider = createOpenAIProvider({ apiKey: '' });
      await expect(
        provider.createChatCompletion({
          messages: [{ role: 'user', content: 'hello' }],
        })
      ).rejects.toThrow('OPENAI_API_KEY is not configured');
    });

    it('maps request, response, and trustworthy usage metadata correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chatcmpl-test-openai',
          object: 'chat.completion',
          created: 1729382400,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OpenAI answer' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 30,
            total_tokens: 45,
          },
        }),
      });

      const provider = createOpenAIProvider({
        apiKey: 'sk-test-key-12345',
        fetchFn: mockFetch as any,
      });

      const res = await provider.createChatCompletion({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.5,
        max_tokens: 100,
      });

      expect(res.id).toBe('chatcmpl-test-openai');
      expect(res.model).toBe('gpt-4o');
      expect(res.choices[0].message.content).toBe('OpenAI answer');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({
        prompt_tokens: 15,
        completion_tokens: 30,
        total_tokens: 45,
      });
      expect(res.rawUsage).toEqual({
        inputTokens: 15,
        outputTokens: 30,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key-12345',
          }),
        })
      );
    });

    it('leaves usage undefined if usage tokens are missing or invalid', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chatcmpl-test-openai-nousage',
          object: 'chat.completion',
          created: 1729382400,
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'answer' } }],
          // No usage object
        }),
      });

      const provider = createOpenAIProvider({
        apiKey: 'sk-test-key',
        fetchFn: mockFetch as any,
      });

      const res = await provider.createChatCompletion({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(res.usage).toBeUndefined();
      expect(res.rawUsage).toBeUndefined();
    });

    it('maps 401 error as authentication error and never leaks API key', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Incorrect API key provided' } }),
      });

      const provider = createOpenAIProvider({
        apiKey: 'sk-secret-token-should-not-leak',
        fetchFn: mockFetch as any,
      });

      await expect(
        provider.createChatCompletion({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('OpenAI authentication error (401)');
    });

    it('maps 429 error as rate limit error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limit exceeded' } }),
      });

      const provider = createOpenAIProvider({
        apiKey: 'sk-test',
        fetchFn: mockFetch as any,
      });

      await expect(
        provider.createChatCompletion({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('OpenAI rate limit exceeded (429)');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Anthropic Provider Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Anthropic Provider', () => {
    it('throws error when ANTHROPIC_API_KEY is missing', async () => {
      const provider = createAnthropicProvider({ apiKey: '' });
      await expect(
        provider.createChatCompletion({
          messages: [{ role: 'user', content: 'hello' }],
        })
      ).rejects.toThrow('ANTHROPIC_API_KEY is not configured');
    });

    it('separates system prompt and maps messages and usage correctly', async () => {
      let capturedBody: any;
      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Anthropic response' }],
            model: 'claude-3-5-sonnet-20241022',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 25,
              output_tokens: 50,
            },
          }),
        };
      });

      const provider = createAnthropicProvider({
        apiKey: 'anthropic-secret-key',
        fetchFn: mockFetch as any,
      });

      const res = await provider.createChatCompletion({
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2?' },
        ],
        max_tokens: 1024,
      });

      expect(capturedBody.system).toBe('You are a helpful assistant.');
      expect(capturedBody.messages).toEqual([{ role: 'user', content: 'What is 2+2?' }]);
      expect(capturedBody.max_tokens).toBe(1024);

      expect(res.choices[0].message.content).toBe('Anthropic response');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({
        prompt_tokens: 25,
        completion_tokens: 50,
        total_tokens: 75,
      });
      expect(res.rawUsage).toEqual({
        inputTokens: 25,
        outputTokens: 50,
      });
    });

    it('maps stop_reason max_tokens to finish_reason length', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_test',
          content: [{ type: 'text', text: 'Truncated...' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 10, output_tokens: 100 },
        }),
      });

      const provider = createAnthropicProvider({
        apiKey: 'sk-ant-test',
        fetchFn: mockFetch as any,
      });

      const res = await provider.createChatCompletion({
        messages: [{ role: 'user', content: 'Write a novel' }],
      });

      expect(res.choices[0].finish_reason).toBe('length');
    });

    it('maps 401 error as authentication error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid x-api-key' } }),
      });

      const provider = createAnthropicProvider({
        apiKey: 'bad-key',
        fetchFn: mockFetch as any,
      });

      await expect(
        provider.createChatCompletion({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('Anthropic authentication error (401)');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Ollama Provider Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Ollama Provider', () => {
    it('maps request to /api/chat and maps eval counts to usage', async () => {
      let capturedUrl = '';
      let capturedBody: any;

      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            model: 'llama3',
            created_at: '2026-10-19T18:00:00.000000Z',
            message: {
              role: 'assistant',
              content: 'Ollama local response',
            },
            done_reason: 'stop',
            done: true,
            prompt_eval_count: 18,
            eval_count: 32,
          }),
        };
      });

      const provider = createOllamaProvider({
        baseUrl: 'http://localhost:11434',
        fetchFn: mockFetch as any,
      });

      const res = await provider.createChatCompletion({
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello Ollama' }],
        temperature: 0.7,
        max_tokens: 50,
      });

      expect(capturedUrl).toBe('http://localhost:11434/api/chat');
      expect(capturedBody.options).toEqual({
        temperature: 0.7,
        num_predict: 50,
      });

      expect(res.choices[0].message.content).toBe('Ollama local response');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({
        prompt_tokens: 18,
        completion_tokens: 32,
        total_tokens: 50,
      });
      expect(res.rawUsage).toEqual({
        inputTokens: 18,
        outputTokens: 32,
      });
    });

    it('leaves usage undefined if Ollama does not report eval counts', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3',
          message: { role: 'assistant', content: 'No eval counts' },
          done: true,
        }),
      });

      const provider = createOllamaProvider({
        baseUrl: 'http://localhost:11434',
        fetchFn: mockFetch as any,
      });

      const res = await provider.createChatCompletion({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(res.usage).toBeUndefined();
      expect(res.rawUsage).toBeUndefined();
    });

    it('maps 404 model not found error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'model "llama-unknown" not found' }),
      });

      const provider = createOllamaProvider({
        baseUrl: 'http://localhost:11434',
        fetchFn: mockFetch as any,
      });

      await expect(
        provider.createChatCompletion({
          model: 'llama-unknown',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow("Ollama model 'llama-unknown' not found (404)");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. End-to-End Gateway Integration via buildServer
  // ──────────────────────────────────────────────────────────────────────────
  describe('5. End-to-End Gateway Integration', () => {
    let app: ReturnType<typeof Fastify> extends Promise<infer U> ? U : any;
    const publishedEvents: any[] = [];

    const mockUsagePublisher: UsageEventPublisher = {
      publish: vi.fn(async (event) => {
        publishedEvents.push(event);
        return { success: true, eventId: event.eventId, streamId: '1-0' };
      }),
      close: vi.fn(async () => {}),
    };

    const mockOpenAiCompletion = vi.fn().mockResolvedValue({
      id: 'chatcmpl-openai-mock',
      object: 'chat.completion',
      created: 1729382400,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OpenAI says hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      rawUsage: { inputTokens: 10, outputTokens: 20 },
    });

    const mockAnthropicCompletion = vi.fn().mockResolvedValue({
      id: 'chatcmpl-anthropic-mock',
      object: 'chat.completion',
      created: 1729382400,
      model: 'claude-3-5-sonnet-20241022',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Anthropic says hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
      rawUsage: { inputTokens: 15, outputTokens: 25 },
    });

    const mockOllamaCompletion = vi.fn().mockResolvedValue({
      id: 'chatcmpl-ollama-mock',
      object: 'chat.completion',
      created: 1729382400,
      model: 'llama3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Ollama says hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 },
      rawUsage: { inputTokens: 30, outputTokens: 40 },
    });

    const mockGeminiCompletion = vi.fn().mockResolvedValue({
      id: 'chatcmpl-gemini-mock',
      object: 'chat.completion',
      created: 1729382400,
      model: 'gemini-1.5-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Gemini says hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      rawUsage: { inputTokens: 5, outputTokens: 10 },
    });

    beforeEach(async () => {
      publishedEvents.length = 0;
      vi.clearAllMocks();

      const router = new ProviderRouter({ defaultProvider: 'gemini' });
      router.register({
        providerName: 'gemini',
        defaultModel: 'gemini-1.5-flash',
        createChatCompletion: mockGeminiCompletion,
      });
      router.register({
        providerName: 'openai',
        defaultModel: 'gpt-4o',
        createChatCompletion: mockOpenAiCompletion,
      });
      router.register({
        providerName: 'anthropic',
        defaultModel: 'claude-3-5-sonnet-20241022',
        createChatCompletion: mockAnthropicCompletion,
      });
      router.register({
        providerName: 'ollama',
        defaultModel: 'llama3',
        createChatCompletion: mockOllamaCompletion,
      });

      app = await buildServer({
        config: {
          port: 3000,
          host: '0.0.0.0',
          logLevel: 'silent',
          auth: { apiKey: API_KEY, tenantId: TENANT_ID },
          gemini: { apiKey: 'test-gemini', model: 'gemini-1.5-flash' },
          redis: { url: 'redis://localhost:6379', stream: 'usage-events', enabled: false, maxRetries: 1, retryDelayMs: 10 },
        },
        providerRouter: router,
        usagePublisher: mockUsagePublisher,
      });
    });

    it('routes gpt-4o request to OpenAI and publishes usage event with provider: "openai"', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
          'x-team-id': 'team-alpha',
        },
        payload: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello OpenAI' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.choices[0].message.content).toBe('OpenAI says hi');
      expect(mockOpenAiCompletion).toHaveBeenCalledTimes(1);

      expect(publishedEvents.length).toBe(1);
      expect(publishedEvents[0].provider).toBe('openai');
      expect(publishedEvents[0].model).toBe('gpt-4o');
      expect(publishedEvents[0].usage).toEqual({ inputTokens: 10, outputTokens: 20 });
      expect(publishedEvents[0].teamId).toBe('team-alpha');
    });

    it('routes claude-3-5-sonnet request to Anthropic and publishes usage event with provider: "anthropic"', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'Hello Claude' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.choices[0].message.content).toBe('Anthropic says hi');
      expect(mockAnthropicCompletion).toHaveBeenCalledTimes(1);

      expect(publishedEvents.length).toBe(1);
      expect(publishedEvents[0].provider).toBe('anthropic');
      expect(publishedEvents[0].model).toBe('claude-3-5-sonnet-20241022');
      expect(publishedEvents[0].usage).toEqual({ inputTokens: 15, outputTokens: 25 });
    });

    it('routes llama3 request to Ollama and publishes usage event with provider: "ollama"', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'llama3',
          messages: [{ role: 'user', content: 'Hello Ollama' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.choices[0].message.content).toBe('Ollama says hi');
      expect(mockOllamaCompletion).toHaveBeenCalledTimes(1);

      expect(publishedEvents.length).toBe(1);
      expect(publishedEvents[0].provider).toBe('ollama');
      expect(publishedEvents[0].model).toBe('llama3');
      expect(publishedEvents[0].usage).toEqual({ inputTokens: 30, outputTokens: 40 });
    });

    it('routes prefixed model "openai/my-custom-model" to OpenAI adapter', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'openai/my-custom-model',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockOpenAiCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'my-custom-model' }),
        expect.anything()
      );
    });

    it('returns HTTP 400 INVALID_REQUEST for unsupported provider prefix', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'nonexistent-provider/custom-model',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data.code).toBe('INVALID_REQUEST');
      expect(data.message).toContain('Unsupported model');
      expect(publishedEvents.length).toBe(0);
    });

    it('returns HTTP 400 INVALID_REQUEST for unsupported bare model and calls no provider', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'some-unknown-unsupported-model-xyz',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data.code).toBe('INVALID_REQUEST');
      expect(data.message).toContain("Unsupported model 'some-unknown-unsupported-model-xyz'");
      expect(publishedEvents.length).toBe(0);
      expect(mockGeminiCompletion).not.toHaveBeenCalled();
      expect(mockOpenAiCompletion).not.toHaveBeenCalled();
      expect(mockAnthropicCompletion).not.toHaveBeenCalled();
      expect(mockOllamaCompletion).not.toHaveBeenCalled();
    });
  });
});
