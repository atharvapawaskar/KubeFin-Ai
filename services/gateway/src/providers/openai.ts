import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderUsage,
} from './types.js';

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export function createOpenAIProvider(options: OpenAIProviderOptions = {}): ProviderAdapter {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    defaultModel = process.env.OPENAI_MODEL || 'gpt-4o',
    timeoutMs = 30000,
    fetchFn = globalThis.fetch,
  } = options;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  function generateId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  async function createChatCompletion(
    request: ChatCompletionRequest,
    execOptions?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse> {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('OpenAI provider authentication error: OPENAI_API_KEY is not configured');
    }

    const modelName = request.model || defaultModel;
    const url = `${normalizedBaseUrl}/chat/completions`;

    const payload: Record<string, unknown> = {
      model: modelName,
      messages: request.messages,
    };
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.max_tokens !== undefined) {
      payload.max_tokens = request.max_tokens;
    }

    // Set up request abort signal with optional timeout
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(new Error('OpenAI request timed out')), timeoutMs);
    }

    const externalSignal = execOptions?.signal;
    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason);
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || errMsg.includes('abort') || errMsg.includes('timed out')) {
        const timeoutErr = new Error(`OpenAI request timed out: ${errMsg}`);
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }

    if (!response.ok) {
      let errDetail = response.statusText;
      try {
        const errJson: any = await response.json();
        if (errJson?.error?.message) {
          errDetail = String(errJson.error.message);
        }
      } catch {
        // Fall back to status text
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenAI authentication error (${response.status}): ${errDetail}`);
      }
      if (response.status === 429) {
        throw new Error(`OpenAI rate limit exceeded (429): ${errDetail}`);
      }
      if (response.status === 408 || response.status === 504) {
        const timeoutErr = new Error(`OpenAI timeout (${response.status}): ${errDetail}`);
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      if (response.status >= 500) {
        throw new Error(`OpenAI provider server error (${response.status}): ${errDetail}`);
      }
      throw new Error(`OpenAI request failed with status ${response.status}: ${errDetail}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new Error(`Failed to parse OpenAI response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Invalid response structure from OpenAI: expected object');
    }

    const choices = Array.isArray(data.choices) && data.choices.length > 0
      ? data.choices.map((c: any, idx: number) => ({
          index: typeof c.index === 'number' ? c.index : idx,
          message: {
            role: 'assistant' as const,
            content: typeof c.message?.content === 'string' ? c.message.content : '',
          },
          finish_reason: typeof c.finish_reason === 'string' ? c.finish_reason : 'stop',
        }))
      : [
          {
            index: 0,
            message: { role: 'assistant' as const, content: '' },
            finish_reason: 'empty_response',
          },
        ];

    const result: ChatCompletionResponse = {
      id: typeof data.id === 'string' && data.id ? data.id : generateId(),
      object: 'chat.completion',
      created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
      model: typeof data.model === 'string' && data.model ? data.model : modelName,
      choices,
    };

    // Extract trustworthy usage metadata
    if (
      data.usage &&
      typeof data.usage.prompt_tokens === 'number' &&
      Number.isInteger(data.usage.prompt_tokens) &&
      data.usage.prompt_tokens >= 0 &&
      Number.isSafeInteger(data.usage.prompt_tokens) &&
      typeof data.usage.completion_tokens === 'number' &&
      Number.isInteger(data.usage.completion_tokens) &&
      data.usage.completion_tokens >= 0 &&
      Number.isSafeInteger(data.usage.completion_tokens)
    ) {
      const promptTokens = data.usage.prompt_tokens;
      const completionTokens = data.usage.completion_tokens;
      const totalTokens =
        typeof data.usage.total_tokens === 'number' &&
        Number.isInteger(data.usage.total_tokens) &&
        data.usage.total_tokens >= 0 &&
        Number.isSafeInteger(data.usage.total_tokens)
          ? data.usage.total_tokens
          : promptTokens + completionTokens;

      const rawUsage: ProviderUsage = {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      };

      result.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      };
      result.rawUsage = rawUsage;
    }

    return result;
  }

  return {
    providerName: 'openai',
    defaultModel,
    createChatCompletion,
  };
}
