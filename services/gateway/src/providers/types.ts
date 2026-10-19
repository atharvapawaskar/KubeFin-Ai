export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatCompletionChoiceMessage {
  role: 'assistant';
  content: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionChoiceMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  rawUsage?: ProviderUsage;
}

export interface ProviderExecutionOptions {
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly providerName: string;
  readonly defaultModel?: string;
  createChatCompletion(
    request: ChatCompletionRequest,
    options?: ProviderExecutionOptions
  ): Promise<ChatCompletionResponse>;
}
