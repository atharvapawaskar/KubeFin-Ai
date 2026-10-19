import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderUsage,
} from './types.js';

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ProviderAdapter {
  const {
    apiKey = process.env.ANTHROPIC_API_KEY,
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    defaultModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
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
      throw new Error('Anthropic provider authentication error: ANTHROPIC_API_KEY is not configured');
    }

    const modelName = request.model || defaultModel;
    const url = `${normalizedBaseUrl}/v1/messages`;

    // Separate system prompt from conversational messages per Anthropic API spec
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const conversationMessages = request.messages.filter((m) => m.role !== 'system');

    const system =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).filter(Boolean).join('\n\n')
        : undefined;

    const messages = conversationMessages.map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    }));

    // Anthropic strictly requires max_tokens
    const maxTokens = request.max_tokens ?? 2048;

    const payload: Record<string, unknown> = {
      model: modelName,
      max_tokens: maxTokens,
      messages,
    };
    if (system) {
      payload.system = system;
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(new Error('Anthropic request timed out')), timeoutMs);
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
          'x-api-key': apiKey.trim(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || errMsg.includes('abort') || errMsg.includes('timed out')) {
        const timeoutErr = new Error(`Anthropic request timed out: ${errMsg}`);
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
        throw new Error(`Anthropic authentication error (${response.status}): ${errDetail}`);
      }
      if (response.status === 429) {
        throw new Error(`Anthropic rate limit exceeded (429): ${errDetail}`);
      }
      if (response.status === 529) {
        throw new Error(`Anthropic overloaded (529): ${errDetail}`);
      }
      if (response.status === 408 || response.status === 504) {
        const timeoutErr = new Error(`Anthropic timeout (${response.status}): ${errDetail}`);
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      if (response.status >= 500) {
        throw new Error(`Anthropic provider server error (${response.status}): ${errDetail}`);
      }
      throw new Error(`Anthropic request failed with status ${response.status}: ${errDetail}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new Error(`Failed to parse Anthropic response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Invalid response structure from Anthropic: expected object');
    }

    let textContent = '';
    if (Array.isArray(data.content)) {
      textContent = data.content
        .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
        .map((block: any) => block.text)
        .join('');
    }

    let finishReason = 'stop';
    if (data.stop_reason === 'max_tokens') {
      finishReason = 'length';
    } else if (data.stop_reason === 'stop_sequence' || data.stop_reason === 'end_turn') {
      finishReason = textContent.length > 0 ? 'stop' : 'empty_response';
    } else if (!textContent) {
      finishReason = 'empty_response';
    }

    const result: ChatCompletionResponse = {
      id: typeof data.id === 'string' && data.id ? data.id : generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof data.model === 'string' && data.model ? data.model : modelName,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent,
          },
          finish_reason: finishReason,
        },
      ],
    };

    // Extract trustworthy Anthropic usage metadata
    if (
      data.usage &&
      typeof data.usage.input_tokens === 'number' &&
      Number.isInteger(data.usage.input_tokens) &&
      data.usage.input_tokens >= 0 &&
      Number.isSafeInteger(data.usage.input_tokens) &&
      typeof data.usage.output_tokens === 'number' &&
      Number.isInteger(data.usage.output_tokens) &&
      data.usage.output_tokens >= 0 &&
      Number.isSafeInteger(data.usage.output_tokens)
    ) {
      const inputTokens = data.usage.input_tokens;
      const outputTokens = data.usage.output_tokens;
      const totalTokens = inputTokens + outputTokens;

      const rawUsage: ProviderUsage = {
        inputTokens,
        outputTokens,
      };

      result.usage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens,
      };
      result.rawUsage = rawUsage;
    }

    return result;
  }

  return {
    providerName: 'anthropic',
    defaultModel,
    createChatCompletion,
  };
}
