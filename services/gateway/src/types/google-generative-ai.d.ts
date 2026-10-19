// Type declarations for @google/generative-ai to allow compilation without the package installed
declare module '@google/generative-ai' {
  export enum HarmCategory {
    HARM_CATEGORY_HARASSMENT = 'HARM_CATEGORY_HARASSMENT',
    HARM_CATEGORY_HATE_SPEECH = 'HARM_CATEGORY_HATE_SPEECH',
    HARM_CATEGORY_SEXUALLY_EXPLICIT = 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    HARM_CATEGORY_DANGEROUS_CONTENT = 'HARM_CATEGORY_DANGEROUS_CONTENT',
  }

  export enum HarmBlockThreshold {
    BLOCK_NONE = 'BLOCK_NONE',
    BLOCK_LOW_AND_ABOVE = 'BLOCK_LOW_AND_ABOVE',
    BLOCK_MEDIUM_AND_ABOVE = 'BLOCK_MEDIUM_AND_ABOVE',
    BLOCK_HIGH_AND_ABOVE = 'BLOCK_HIGH_AND_ABOVE',
    BLOCK_ONLY_HIGH = 'BLOCK_ONLY_HIGH',
  }

  export interface SafetySetting {
    category: HarmCategory;
    threshold: HarmBlockThreshold;
  }

  export interface GenerationConfig {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  }

  export interface GenerateContentRequest {
    contents: Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    systemInstruction?: {
      role: string;
      parts: Array<{ text: string }>;
    };
    generationConfig?: GenerationConfig;
    safetySettings?: SafetySetting[];
  }

  export interface ContentPart {
    text: string;
  }

  export interface Content {
    parts: ContentPart[];
    role: string;
  }

  export interface Candidate {
    content: Content;
    finishReason: string;
    index?: number;
    safetyRatings?: Array<{ category: HarmCategory; probability: string }>;
  }

  export interface UsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  }

  export interface RequestOptions {
    timeout?: number;
    apiVersion?: string;
    baseUrl?: string;
    customHeaders?: Record<string, string>;
  }

  export interface GenerateContentResult {
    response: {
      text(): string;
      candidates?: Candidate[];
      promptFeedback?: {
        blockReason?: string;
        safetyRatings?: Array<{ category: HarmCategory; probability: string }>;
      };
      usageMetadata?: UsageMetadata;
      modelVersion?: string;
    };
  }

  export interface GenerateContentResponse extends GenerateContentResult {}

  export interface ModelParams {
    model: string;
    systemInstruction?: string | { role?: string; parts: Array<{ text: string }> };
    safetySettings?: SafetySetting[];
    generationConfig?: GenerationConfig;
  }

  export class GoogleGenerativeAI {
    constructor(apiKey: string);
    getGenerativeModel(
      options: ModelParams,
      requestOptions?: RequestOptions
    ): GenerativeModel;
  }

  export class GenerativeModel {
    generateContent(
      request: GenerateContentRequest | string | Array<string | ContentPart>,
      requestOptions?: RequestOptions
    ): Promise<GenerateContentResult>;
    startChat(options?: { history?: Array<{ role: string; parts: Array<{ text: string }> }>; generationConfig?: GenerationConfig }): ChatSession;
  }

  export class ChatSession {
    sendMessage(message: string | Array<string | ContentPart>, requestOptions?: RequestOptions): Promise<GenerateContentResponse>;
  }
}