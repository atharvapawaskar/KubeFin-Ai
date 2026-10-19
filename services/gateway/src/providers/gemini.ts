import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import type {
  ChatMessage,
  ChatCompletionRequest,
  ProviderUsage,
  ChatCompletionResponse,
  ProviderAdapter,
  ProviderExecutionOptions,
} from './types.js';

export type {
  ChatMessage,
  ChatCompletionRequest,
  ProviderUsage,
  ChatCompletionResponse,
  ProviderAdapter,
  ProviderExecutionOptions,
};

export interface GeminiProviderOptions {
  apiKey: string;
  defaultModel: string;
  timeoutMs?: number;
}

export function extractUsageMetadata(response: any): ProviderUsage | undefined {
  const metadata = response?.usageMetadata;
  if (!metadata) {
    return undefined;
  }

  const { promptTokenCount, candidatesTokenCount, thoughtsTokenCount } = metadata;

  // Validate promptTokenCount is a non-negative safe integer
  const isValidPrompt =
    typeof promptTokenCount === 'number' &&
    Number.isInteger(promptTokenCount) &&
    promptTokenCount >= 0 &&
    promptTokenCount <= Number.MAX_SAFE_INTEGER;

  // Validate candidatesTokenCount is a non-negative safe integer
  // Note: outputTokens: 0 is valid ONLY when explicitly reported by provider
  const isValidCandidates =
    typeof candidatesTokenCount === 'number' &&
    Number.isInteger(candidatesTokenCount) &&
    candidatesTokenCount >= 0 &&
    candidatesTokenCount <= Number.MAX_SAFE_INTEGER;

  // Validate thoughtsTokenCount: optional, but if present must be a non-negative safe integer
  const isValidThoughts =
    thoughtsTokenCount === undefined ||
    (typeof thoughtsTokenCount === 'number' &&
      Number.isInteger(thoughtsTokenCount) &&
      thoughtsTokenCount >= 0 &&
      thoughtsTokenCount <= Number.MAX_SAFE_INTEGER);

  if (!isValidPrompt || !isValidCandidates || !isValidThoughts) {
    return undefined;
  }

  const thoughts = thoughtsTokenCount ?? 0;
  const totalOutputTokens = candidatesTokenCount + thoughts;

  // Validate the sum with Number.isSafeInteger and ensure within safe integer bounds
  if (!Number.isSafeInteger(totalOutputTokens) || totalOutputTokens > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }

  return {
    inputTokens: promptTokenCount,
    outputTokens: totalOutputTokens,
  };
}

export function extractServedModel(response: unknown, fallbackModel: string): string {
  if (typeof response === 'object' && response !== null && 'modelVersion' in response) {
    const rawVersion = (response as { modelVersion?: unknown }).modelVersion;
    if (typeof rawVersion === 'string') {
      const trimmed = rawVersion.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return fallbackModel;
}

export interface ExtractedResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'empty_response';
}

const CONTENT_FILTER_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALICIOUS',
]);

export function extractTextFromResponse(response: any): ExtractedResponse {
  if (!response || typeof response !== 'object') {
    return { text: '', finishReason: 'empty_response' };
  }

  // 1. Check prompt-level feedback for safety / policy blocks
  const promptFeedback = response.promptFeedback;
  if (promptFeedback?.blockReason) {
    return { text: '', finishReason: 'content_filter' };
  }

  // 2. Check candidates array
  const candidates = response.candidates;
  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    return { text: '', finishReason: 'empty_response' };
  }

  const candidate = candidates[0];
  if (!candidate || typeof candidate !== 'object') {
    return { text: '', finishReason: 'empty_response' };
  }

  // 3. Extract text from candidate parts
  let text = '';
  if (candidate.content?.parts && Array.isArray(candidate.content.parts)) {
    const textParts = candidate.content.parts
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter((t: string) => t.length > 0);
    text = textParts.join('');
  }

  // 4. Fallback to response.text() if parts didn't yield text and helper exists
  if (!text && typeof response.text === 'function') {
    try {
      const sdkText = response.text();
      if (typeof sdkText === 'string') {
        text = sdkText;
      }
    } catch {
      // SDK text() throws GoogleGenerativeAIResponseError when candidate was blocked by safety/recitation
    }
  }

  // 5. Map Gemini finish reasons to OpenAI-compatible finish_reason
  const rawFinishReason =
    typeof candidate.finishReason === 'string' ? candidate.finishReason.toUpperCase() : '';

  if (CONTENT_FILTER_FINISH_REASONS.has(rawFinishReason)) {
    return { text: text || '', finishReason: 'content_filter' };
  }

  if (rawFinishReason === 'MAX_TOKENS') {
    return { text, finishReason: 'length' };
  }

  if (rawFinishReason === 'STOP') {
    if (text.length > 0) {
      return { text, finishReason: 'stop' };
    }
    return { text: '', finishReason: 'empty_response' };
  }

  // If text was generated but finishReason is OTHER, FINISH_REASON_UNSPECIFIED, or missing
  if (text.length > 0) {
    return { text, finishReason: 'stop' };
  }

  // No text and no recognized finish reason
  return { text: '', finishReason: 'empty_response' };
}

// Model alias map for backward compatibility; preserves requested model by default
export const MODEL_ALIASES: Record<string, string> = {};

export function resolveUpstreamModel(modelName: string): string {
  const trimmed = modelName.trim();
  return MODEL_ALIASES[trimmed] || trimmed;
}

export function createGeminiProvider(options: GeminiProviderOptions) {
  const { apiKey, defaultModel, timeoutMs } = options;
  const genAI = new GoogleGenerativeAI(apiKey);

  // Safety settings - allow most content but block dangerous content
  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ];

  function generateId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  async function createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const modelName = request.model || defaultModel;
    const upstreamModel = resolveUpstreamModel(modelName);
    const requestOptions =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeout: timeoutMs } : undefined;

    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const conversationMessages = request.messages.filter((m) => m.role !== 'system');

    const systemInstruction =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).filter(Boolean).join('\n\n')
        : undefined;

    const model = genAI.getGenerativeModel(
      {
        model: upstreamModel,
        systemInstruction: systemInstruction || undefined,
        safetySettings,
        generationConfig: {
          temperature: request.temperature ?? 0.7,
          maxOutputTokens: request.max_tokens ?? 2048,
        },
      },
      requestOptions
    );

    if (conversationMessages.length === 0) {
      throw new Error('At least one non-system message is required');
    }

    const contents = conversationMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const result = await model.generateContent({ contents }, requestOptions);
    const response = result.response;
    const { text, finishReason } = extractTextFromResponse(response);

    // Extract actual provider usage metadata without estimating tokens
    const providerUsage = extractUsageMetadata(response);

    // Prefer Google's returned modelVersion when it is a non-empty string, otherwise fall back to requested model
    const effectiveModel = extractServedModel(response, modelName);

    const completionResponse: ChatCompletionResponse = {
      id: generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: effectiveModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
          },
          finish_reason: finishReason,
        },
      ],
    };

    if (providerUsage) {
      const promptTokens = providerUsage.inputTokens;
      const completionTokens = providerUsage.outputTokens;
      const totalTokens =
        typeof response?.usageMetadata?.totalTokenCount === 'number' &&
        Number.isInteger(response.usageMetadata.totalTokenCount) &&
        response.usageMetadata.totalTokenCount >= 0
          ? response.usageMetadata.totalTokenCount
          : promptTokens + completionTokens;

      completionResponse.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      };
      completionResponse.rawUsage = providerUsage;
    }

    return completionResponse;
  }

  return {
    providerName: 'gemini' as const,
    defaultModel,
    createChatCompletion,
  };
}

export type GeminiProvider = ReturnType<typeof createGeminiProvider>;