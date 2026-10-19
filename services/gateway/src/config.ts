export interface AuthConfig {
  apiKey: string;
  tenantId: string;
}

export function loadAuthConfig(): AuthConfig {
  const apiKey = process.env.API_KEY;
  const tenantId = process.env.TENANT_ID || 'default-tenant';

  if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
  }

  return {
    apiKey,
    tenantId,
  };
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export function loadGeminiConfig(): GeminiConfig {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  let timeoutMs = 30000;
  const rawTimeout = process.env.GEMINI_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const trimmed = rawTimeout.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('GEMINI_TIMEOUT_MS must be a positive integer between 1 and 600000 milliseconds');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed <= 0 || parsed > 600000) {
      throw new Error('GEMINI_TIMEOUT_MS must be a positive integer between 1 and 600000 milliseconds');
    }
    timeoutMs = parsed;
  }

  return {
    apiKey,
    model,
    timeoutMs,
  };
}

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
}

export function loadOpenAIConfig(): OpenAIConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  let timeoutMs = 30000;
  const rawTimeout = process.env.OPENAI_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const trimmed = rawTimeout.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed > 0 && parsed <= 600000) {
        timeoutMs = parsed;
      }
    }
  }

  return { apiKey, baseUrl, model, timeoutMs };
}

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
}

export function loadAnthropicConfig(): AnthropicConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  let timeoutMs = 30000;
  const rawTimeout = process.env.ANTHROPIC_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const trimmed = rawTimeout.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed > 0 && parsed <= 600000) {
        timeoutMs = parsed;
      }
    }
  }

  return { apiKey, baseUrl, model, timeoutMs };
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export function loadOllamaConfig(): OllamaConfig {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3';
  let timeoutMs = 30000;
  const rawTimeout = process.env.OLLAMA_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const trimmed = rawTimeout.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed > 0 && parsed <= 600000) {
        timeoutMs = parsed;
      }
    }
  }

  return { baseUrl, model, timeoutMs };
}

export interface ProvidersConfig {
  defaultProvider: string;
  gemini: GeminiConfig;
  openai: OpenAIConfig;
  anthropic: AnthropicConfig;
  ollama: OllamaConfig;
}

export function loadProvidersConfig(geminiConfig?: GeminiConfig): ProvidersConfig {
  return {
    defaultProvider: process.env.DEFAULT_PROVIDER || 'gemini',
    gemini: geminiConfig || loadGeminiConfig(),
    openai: loadOpenAIConfig(),
    anthropic: loadAnthropicConfig(),
    ollama: loadOllamaConfig(),
  };
}

export interface RedisConfig {
  url: string;
  stream: string;
  enabled: boolean;
  maxRetries: number;
  retryDelayMs: number;
}

export function loadRedisConfig(): RedisConfig {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const stream = process.env.REDIS_USAGE_STREAM || 'usage-events';
  const enabled = process.env.REDIS_ENABLED !== 'false';
  const maxRetries = process.env.REDIS_MAX_RETRIES ? parseInt(process.env.REDIS_MAX_RETRIES, 10) : 3;
  const retryDelayMs = process.env.REDIS_RETRY_DELAY_MS ? parseInt(process.env.REDIS_RETRY_DELAY_MS, 10) : 100;

  return {
    url,
    stream,
    enabled,
    maxRetries,
    retryDelayMs,
  };
}

export interface RateLimitConfig {
  enabled: boolean;
  maxRequests: number;
  windowMs: number;
  failureMode: 'fail-closed' | 'fail-open';
  redisKeyPrefix: string;
}

export function loadRateLimitConfig(): RateLimitConfig {
  const enabled = process.env.RATE_LIMIT_ENABLED !== 'false';

  let maxRequests = 60;
  const rawMax = process.env.RATE_LIMIT_MAX_REQUESTS;
  if (rawMax !== undefined) {
    const trimmed = rawMax.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('RATE_LIMIT_MAX_REQUESTS must be a positive integer between 1 and 10000000');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed <= 0 || parsed > 10_000_000) {
      throw new Error('RATE_LIMIT_MAX_REQUESTS must be a positive integer between 1 and 10000000');
    }
    maxRequests = parsed;
  }

  let windowMs = 60000;
  const rawWindow = process.env.RATE_LIMIT_WINDOW_MS;
  if (rawWindow !== undefined) {
    const trimmed = rawWindow.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('RATE_LIMIT_WINDOW_MS must be a positive integer between 1000 and 86400000 milliseconds');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed < 1000 || parsed > 86_400_000) {
      throw new Error('RATE_LIMIT_WINDOW_MS must be a positive integer between 1000 and 86400000 milliseconds');
    }
    windowMs = parsed;
  }

  let failureMode: 'fail-closed' | 'fail-open' = 'fail-closed';
  const rawFailureMode = process.env.RATE_LIMIT_FAILURE_MODE;
  if (rawFailureMode !== undefined) {
    const trimmed = rawFailureMode.trim();
    if (trimmed !== 'fail-closed' && trimmed !== 'fail-open') {
      throw new Error("RATE_LIMIT_FAILURE_MODE must be either 'fail-closed' or 'fail-open'");
    }
    failureMode = trimmed;
  }

  let redisKeyPrefix = 'ratelimit:tenant';
  if (process.env.RATE_LIMIT_REDIS_KEY_PREFIX !== undefined) {
    const trimmed = process.env.RATE_LIMIT_REDIS_KEY_PREFIX.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      throw new Error('RATE_LIMIT_REDIS_KEY_PREFIX must be a non-empty string with maximum length of 128 characters');
    }
    redisKeyPrefix = trimmed;
  }

  return {
    enabled,
    maxRequests,
    windowMs,
    failureMode,
    redisKeyPrefix,
  };
}

export interface MetricsConfig {
  enabled: boolean;
  authToken?: string;
}

export function loadMetricsConfig(): MetricsConfig {
  const enabled = process.env.METRICS_ENABLED !== 'false';
  const rawToken = process.env.METRICS_AUTH_TOKEN;
  let authToken: string | undefined;

  if (rawToken !== undefined) {
    const trimmed = rawToken.trim();
    if (trimmed.length === 0) {
      throw new Error('METRICS_AUTH_TOKEN must be a non-empty string if provided');
    }
    authToken = trimmed;
  }

  return {
    enabled,
    authToken,
  };
}

export interface PolicyConfig {
  allowedModels?: string[];
  maxTokensLimit?: number;
}

export function loadPolicyConfig(): PolicyConfig {
  const rawAllowed = process.env.GATEWAY_ALLOWED_MODELS;
  let allowedModels: string[] | undefined;

  if (rawAllowed !== undefined) {
    const trimmed = rawAllowed.trim();
    if (trimmed.length === 0) {
      throw new Error('GATEWAY_ALLOWED_MODELS must contain at least one valid model identifier if specified');
    }
    const items = trimmed.split(',').map((m) => m.trim());
    if (items.some((m) => m.length === 0)) {
      throw new Error('GATEWAY_ALLOWED_MODELS must not contain empty model identifiers');
    }
    if (items.some((m) => m.length > 256 || !/^[a-zA-Z0-9_.:\/-]+$/.test(m))) {
      throw new Error('GATEWAY_ALLOWED_MODELS contains invalid model identifiers (max 256 characters, valid symbols)');
    }
    allowedModels = Array.from(new Set(items));
  }

  const rawMaxTokens = process.env.GATEWAY_MAX_TOKENS_LIMIT;
  let maxTokensLimit: number | undefined;

  if (rawMaxTokens !== undefined) {
    const trimmed = rawMaxTokens.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('GATEWAY_MAX_TOKENS_LIMIT must be a positive integer between 1 and 2147483647');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed <= 0 || parsed > 2_147_483_647) {
      throw new Error('GATEWAY_MAX_TOKENS_LIMIT must be a positive integer between 1 and 2147483647');
    }
    maxTokensLimit = parsed;
  }

  return {
    allowedModels,
    maxTokensLimit,
  };
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 1048576; // 1 MiB (1024 * 1024 bytes)

export function loadMaxPayloadBytesConfig(): number {
  const rawLimit = process.env.GATEWAY_MAX_PAYLOAD_BYTES;
  if (rawLimit === undefined) {
    return DEFAULT_MAX_PAYLOAD_BYTES;
  }

  const trimmed = rawLimit.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('GATEWAY_MAX_PAYLOAD_BYTES must be a positive integer between 1 and 2147483647');
  }

  const parsed = parseInt(trimmed, 10);
  if (parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error('GATEWAY_MAX_PAYLOAD_BYTES must be a positive integer between 1 and 2147483647');
  }

  return parsed;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxProbes: number;
}

export function loadCircuitBreakerConfig(): CircuitBreakerConfig {
  const enabled = process.env.CIRCUIT_BREAKER_ENABLED !== 'false';

  let failureThreshold = 5;
  const rawThreshold = process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  if (rawThreshold !== undefined) {
    const trimmed = rawThreshold.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer between 1 and 1000');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed <= 0 || parsed > 1000) {
      throw new Error('CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer between 1 and 1000');
    }
    failureThreshold = parsed;
  }

  let resetTimeoutMs = 30000;
  const rawTimeout = process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const trimmed = rawTimeout.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('CIRCUIT_BREAKER_RESET_TIMEOUT_MS must be a positive integer between 100 and 86400000');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed < 100 || parsed > 86_400_000) {
      throw new Error('CIRCUIT_BREAKER_RESET_TIMEOUT_MS must be a positive integer between 100 and 86400000');
    }
    resetTimeoutMs = parsed;
  }

  let halfOpenMaxProbes = 1;
  const rawProbes = process.env.CIRCUIT_BREAKER_HALF_OPEN_PROBES;
  if (rawProbes !== undefined) {
    const trimmed = rawProbes.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('CIRCUIT_BREAKER_HALF_OPEN_PROBES must be a positive integer between 1 and 100');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed <= 0 || parsed > 100) {
      throw new Error('CIRCUIT_BREAKER_HALF_OPEN_PROBES must be a positive integer between 1 and 100');
    }
    halfOpenMaxProbes = parsed;
  }

  return {
    enabled,
    failureThreshold,
    resetTimeoutMs,
    halfOpenMaxProbes,
  };
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function loadRetryConfig(): RetryConfig {
  let maxRetries = 2;
  const rawRetries = process.env.UPSTREAM_MAX_RETRIES;
  if (rawRetries !== undefined) {
    const trimmed = rawRetries.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('UPSTREAM_MAX_RETRIES must be an integer between 0 and 10');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed < 0 || parsed > 10) {
      throw new Error('UPSTREAM_MAX_RETRIES must be an integer between 0 and 10');
    }
    maxRetries = parsed;
  }

  let baseDelayMs = 200;
  const rawBase = process.env.UPSTREAM_RETRY_BASE_DELAY_MS;
  if (rawBase !== undefined) {
    const trimmed = rawBase.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('UPSTREAM_RETRY_BASE_DELAY_MS must be a positive integer between 10 and 60000');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed < 10 || parsed > 60000) {
      throw new Error('UPSTREAM_RETRY_BASE_DELAY_MS must be a positive integer between 10 and 60000');
    }
    baseDelayMs = parsed;
  }

  let maxDelayMs = 2000;
  const rawMax = process.env.UPSTREAM_RETRY_MAX_DELAY_MS;
  if (rawMax !== undefined) {
    const trimmed = rawMax.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('UPSTREAM_RETRY_MAX_DELAY_MS must be a positive integer between 10 and 300000');
    }
    const parsed = parseInt(trimmed, 10);
    if (parsed < 10 || parsed > 300000) {
      throw new Error('UPSTREAM_RETRY_MAX_DELAY_MS must be a positive integer between 10 and 300000');
    }
    if (parsed < baseDelayMs) {
      throw new Error('UPSTREAM_RETRY_MAX_DELAY_MS must be a positive integer greater than or equal to UPSTREAM_RETRY_BASE_DELAY_MS');
    }
    maxDelayMs = parsed;
  }

  if (maxDelayMs < baseDelayMs) {
    maxDelayMs = baseDelayMs;
  }

  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
  };
}

export interface ResilienceConfig {
  circuitBreaker: CircuitBreakerConfig;
  retry: RetryConfig;
}

export function loadResilienceConfig(): ResilienceConfig {
  return {
    circuitBreaker: loadCircuitBreakerConfig(),
    retry: loadRetryConfig(),
  };
}

export interface ServerConfig {
  port: number;
  host: string;
  logLevel: string;
  maxPayloadBytes?: number;
  auth: AuthConfig;
  gemini: GeminiConfig;
  redis: RedisConfig;
  rateLimit?: RateLimitConfig;
  metrics?: MetricsConfig;
  policy?: PolicyConfig;
  resilience?: ResilienceConfig;
  providers?: ProvidersConfig;
}

export function loadConfig(): ServerConfig {
  const gemini = loadGeminiConfig();
  return {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
    maxPayloadBytes: loadMaxPayloadBytesConfig(),
    auth: loadAuthConfig(),
    gemini,
    providers: loadProvidersConfig(gemini),
    redis: loadRedisConfig(),
    rateLimit: loadRateLimitConfig(),
    metrics: loadMetricsConfig(),
    policy: loadPolicyConfig(),
    resilience: loadResilienceConfig(),
  };
}