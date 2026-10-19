import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderUsage,
} from './types.js';

export interface OllamaProviderOptions {
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export function createOllamaProvider(options: OllamaProviderOptions = {}): ProviderAdapter {
  const {
    baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    defaultModel = process.env.OLLAMA_MODEL || 'llama3',
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
    const modelName = request.model || defaultModel;
    const url = `${normalizedBaseUrl}/api/chat`;

    const payload: Record<string, unknown> = {
      model: modelName,
      messages: request.messages,
      stream: false,
    };

    const ollamaOptions: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      ollamaOptions.temperature = request.temperature;
    }
    if (request.max_tokens !== undefined) {
      ollamaOptions.num_predict = request.max_tokens;
    }
    if (Object.keys(ollamaOptions).length > 0) {
      payload.options = ollamaOptions;
    }

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(new Error('Ollama request timed out')), timeoutMs);
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
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || errMsg.includes('abort') || errMsg.includes('timed out')) {
        const timeoutErr = new Error(`Ollama request timed out: ${errMsg}`);
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
        if (errJson?.error) {
          errDetail = typeof errJson.error === 'string' ? errJson.error : JSON.stringify(errJson.error);
        }
      } catch {
        // Fall back to status text
      }

      if (response.status === 404) {
        throw new Error(`Ollama model '${modelName}' not found (404): ${errDetail}`);
      }
      if (response.status === 408 || response.status === 504) {
        const timeoutErr = new Error(`Ollama timeout (${response.status}): ${errDetail}`);
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      if (response.status >= 500) {
        throw new Error(`Ollama provider server error (${response.status}): ${errDetail}`);
      }
      throw new Error(`Ollama request failed with status ${response.status}: ${errDetail}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new Error(`Failed to parse Ollama response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Invalid response structure from Ollama: expected object');
    }

    const textContent = typeof data.message?.content === 'string' ? data.message.content : '';

    let finishReason = 'stop';
    if (data.done_reason === 'length') {
      finishReason = 'length';
    } else if (!textContent) {
      finishReason = 'empty_response';
    }

    const result: ChatCompletionResponse = {
      id: generateId(),
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

    // Extract trustworthy usage metadata if explicitly reported by Ollama
    if (
      typeof data.prompt_eval_count === 'number' &&
      Number.isInteger(data.prompt_eval_count) &&
      data.prompt_eval_count >= 0 &&
      Number.isSafeInteger(data.prompt_eval_count) &&
      typeof data.eval_count === 'number' &&
      Number.isInteger(data.eval_count) &&
      data.eval_count >= 0 &&
      Number.isSafeInteger(data.eval_count)
    ) {
      const promptTokens = data.prompt_eval_count;
      const completionTokens = data.eval_count;
      const totalTokens = promptTokens + completionTokens;

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
    providerName: 'ollama',
    defaultModel,
    createChatCompletion,
  };
}
