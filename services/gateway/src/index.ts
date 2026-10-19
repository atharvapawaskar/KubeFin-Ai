import 'dotenv/config';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  ServerConfig,
  loadRateLimitConfig,
  loadMetricsConfig,
  loadPolicyConfig,
  PolicyConfig,
  DEFAULT_MAX_PAYLOAD_BYTES,
  loadMaxPayloadBytesConfig,
  ResilienceConfig,
  CircuitBreakerConfig,
  RetryConfig,
} from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import {
  createGeminiProvider,
  GeminiProvider,
  ChatCompletionRequest,
  extractUsageMetadata,
  ProviderAdapter,
  ProviderRouter,
  ResolvedProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  createOllamaProvider,
} from './providers/index.js';
import { createUsageEvent } from './events/usage-event.js';
import {
  RedisUsageEventPublisher,
  UsageEventPublisher,
  NoopUsageEventPublisher,
  sanitizeErrorMessage,
} from './events/redis-publisher.js';
import {
  createRateLimitMiddleware,
  RateLimiter,
  RateLimitRedisClientLike,
  RedisRateLimiter,
  MemoryRateLimiter,
} from './middleware/rate-limit.js';
import { MetricsRegistry, normalizeRoute } from './metrics.js';
import {
  createPolicyMiddleware,
  isModelAllowed,
  isMaxTokensExceeded,
  PolicyMiddlewareOptions,
} from './middleware/policy.js';
import {
  DEFAULT_MAX_JSON_DEPTH,
  isExcessiveNesting,
  validateInboundHeader,
  validateTokenCount,
  validateTemperature,
} from './security.js';
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerPermit,
  CircuitBreakerState,
  CircuitBreakerStats,
  executeWithRetry,
  isTransientError,
  calculateRetryDelay,
  RetryDelayOptions,
  ExecuteWithRetryOptions,
} from './resilience/index.js';
import './types.js'; // Import for type augmentation

export {
  RateLimiter,
  RateLimitRedisClientLike,
  RedisRateLimiter,
  MemoryRateLimiter,
  MetricsRegistry,
  normalizeRoute,
  createPolicyMiddleware,
  isModelAllowed,
  isMaxTokensExceeded,
  PolicyMiddlewareOptions,
  PolicyConfig,
  DEFAULT_MAX_PAYLOAD_BYTES,
  loadMaxPayloadBytesConfig,
  DEFAULT_MAX_JSON_DEPTH,
  isExcessiveNesting,
  validateInboundHeader,
  validateTokenCount,
  validateTemperature,
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerPermit,
  CircuitBreakerState,
  CircuitBreakerStats,
  executeWithRetry,
  isTransientError,
  calculateRetryDelay,
  RetryDelayOptions,
  ExecuteWithRetryOptions,
  ResilienceConfig,
  CircuitBreakerConfig,
  RetryConfig,
  ProviderAdapter,
  ProviderRouter,
  ResolvedProvider,
  createGeminiProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  createOllamaProvider,
};

export interface BuildServerOptions {
  config?: ServerConfig;
  maxPayloadBytes?: number;
  geminiProvider?: GeminiProvider;
  openaiProvider?: ProviderAdapter;
  anthropicProvider?: ProviderAdapter;
  ollamaProvider?: ProviderAdapter;
  providerRouter?: ProviderRouter;
  usagePublisher?: UsageEventPublisher;
  rateLimiter?: RateLimiter;
  rateLimiterClient?: RateLimitRedisClientLike;
  metricsRegistry?: MetricsRegistry;
  policy?: PolicyConfig;
  circuitBreaker?: CircuitBreaker | null;
  resilience?: ResilienceConfig;
  retrySleep?: (ms: number) => Promise<void>;
  registerSignals?: boolean;
}

export function registerSignalHandlers(fastify: Fastify.FastifyInstance): () => void {
  let isShuttingDown = false;

  const handleSignal = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    fastify.log.info({ signal }, 'Gateway received shutdown signal, closing server');
    try {
      await fastify.close();
      fastify.log.info('Gateway server closed cleanly');
    } catch (err) {
      fastify.log.error({ error: err }, 'Error during gateway shutdown');
      process.exitCode = 1;
    }
  };

  const sigtermHandler = () => {
    void handleSignal('SIGTERM');
  };
  const sigintHandler = () => {
    void handleSignal('SIGINT');
  };

  process.once('SIGTERM', sigtermHandler);
  process.once('SIGINT', sigintHandler);

  const cleanup = () => {
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('SIGINT', sigintHandler);
  };

  fastify.addHook('onClose', async () => {
    cleanup();
  });

  return cleanup;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config || loadConfig();
  const maxPayloadBytes = options.maxPayloadBytes ?? config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  const fastify = Fastify({
    bodyLimit: maxPayloadBytes,
    logger: {
      level: config.logLevel,
    },
  });

  // Centralized Error Handler enforcing consistent Gateway error responses
  fastify.setErrorHandler((error, request, reply) => {
    // 1. Request payload exceeds bodyLimit (HTTP 413)
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: 'Payload Too Large',
        message: `Request body exceeds maximum permitted size of ${maxPayloadBytes} bytes`,
        code: 'PAYLOAD_TOO_LARGE',
      });
    }

    // 2. Syntax errors, empty JSON body, invalid media type, prototype / constructor poisoning (HTTP 400)
    if (
      error instanceof SyntaxError ||
      error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      (error.message && error.message.includes('forbidden prototype property'))
    ) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: error.message || 'Invalid or malformed JSON payload',
        code: 'INVALID_JSON',
      });
    }

    // 3. Excessive JSON parser recursion / stack overflow (HTTP 400)
    if (error instanceof RangeError && error.message.includes('Maximum call stack size exceeded')) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'JSON payload exceeds maximum parsing depth',
        code: 'EXCESSIVE_NESTING',
      });
    }

    // Default error handling
    const statusCode = error.statusCode || 500;
    const code = (error as any).code || (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');
    return reply.code(statusCode).send({
      error: error.name || 'Error',
      message: error.message || 'An unexpected error occurred',
      code,
    });
  });

  if (options.registerSignals) {
    registerSignalHandlers(fastify);
  }

  // Initialize Resilience & Circuit Breaker
  const resilienceConfig = options.resilience ?? config.resilience;
  const circuitBreaker =
    options.circuitBreaker !== undefined
      ? options.circuitBreaker
      : resilienceConfig && resilienceConfig.circuitBreaker.enabled !== false
        ? new CircuitBreaker({
            failureThreshold: resilienceConfig.circuitBreaker.failureThreshold,
            resetTimeoutMs: resilienceConfig.circuitBreaker.resetTimeoutMs,
            halfOpenMaxProbes: resilienceConfig.circuitBreaker.halfOpenMaxProbes,
          })
        : null;

  // Initialize Providers & Router
  const providerRouter =
    options.providerRouter ||
    (() => {
      const router = new ProviderRouter({
        defaultProvider: config.providers?.defaultProvider || 'gemini',
      });

      // 1. Gemini provider (always registered or passed via options)
      const gemini =
        options.geminiProvider ||
        createGeminiProvider({
          apiKey: config.gemini.apiKey,
          defaultModel: config.gemini.model,
          timeoutMs: config.gemini.timeoutMs,
        });
      router.register(gemini);

      // 2. OpenAI provider
      if (options.openaiProvider) {
        router.register(options.openaiProvider);
      } else if (config.providers?.openai?.apiKey) {
        router.register(createOpenAIProvider(config.providers.openai));
      }

      // 3. Anthropic provider
      if (options.anthropicProvider) {
        router.register(options.anthropicProvider);
      } else if (config.providers?.anthropic?.apiKey) {
        router.register(createAnthropicProvider(config.providers.anthropic));
      }

      // 4. Ollama provider
      if (options.ollamaProvider) {
        router.register(options.ollamaProvider);
      } else if (config.providers?.ollama?.baseUrl) {
        router.register(createOllamaProvider(config.providers.ollama));
      }

      return router;
    })();

  // Initialize Usage Event Publisher
  const usagePublisher: UsageEventPublisher =
    options.usagePublisher ||
    (config.redis.enabled
      ? new RedisUsageEventPublisher({
          url: config.redis.url,
          stream: config.redis.stream,
          maxRetries: config.redis.maxRetries,
          retryDelayMs: config.redis.retryDelayMs,
          logger: fastify.log,
        })
      : new NoopUsageEventPublisher());

  // Close publisher when fastify closes
  fastify.addHook('onClose', async () => {
    await usagePublisher.close();
  });

  // Initialize Metrics Registry
  const metricsConfig = config.metrics ?? loadMetricsConfig();
  const metricsRegistry = options.metricsRegistry || new MetricsRegistry();

  const skipPublicPaths = ['/health', '/metrics'];

  // Register authentication middleware
  fastify.addHook(
    'onRequest',
    createAuthMiddleware({
      apiKey: config.auth.apiKey,
      tenantId: config.auth.tenantId,
      skipPaths: skipPublicPaths,
    })
  );

  // Register JSON recursion depth check
  fastify.addHook('preValidation', async (request, reply) => {
    if (skipPublicPaths.includes(request.url)) {
      return;
    }
    if (request.method !== 'POST') {
      return;
    }
    if (request.body && isExcessiveNesting(request.body, DEFAULT_MAX_JSON_DEPTH)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: `Request payload exceeds maximum allowed nesting depth of ${DEFAULT_MAX_JSON_DEPTH}`,
        code: 'EXCESSIVE_NESTING',
      });
    }
  });

  // Initialize Rate Limiter if enabled or passed in options
  const rateLimitConfig = config.rateLimit;
  let rateLimiter: RateLimiter | null = null;

  if (options.rateLimiter) {
    rateLimiter = options.rateLimiter;
  } else if (rateLimitConfig && rateLimitConfig.enabled) {
    if (config.redis.enabled) {
      rateLimiter = new RedisRateLimiter({
        url: config.redis.url,
        maxRequests: rateLimitConfig.maxRequests,
        windowMs: rateLimitConfig.windowMs,
        prefix: rateLimitConfig.redisKeyPrefix,
        failureMode: rateLimitConfig.failureMode,
        client: options.rateLimiterClient,
        logger: fastify.log,
      });
    } else {
      rateLimiter = new MemoryRateLimiter({
        maxRequests: rateLimitConfig.maxRequests,
        windowMs: rateLimitConfig.windowMs,
      });
    }
  }

  if (rateLimiter) {
    fastify.addHook(
      'preHandler',
      createRateLimitMiddleware({
        rateLimiter,
        skipPaths: skipPublicPaths,
        onRateLimited: (req) => {
          if (metricsConfig.enabled) {
            metricsRegistry.rateLimitRejectionsTotal.inc({ route: normalizeRoute(req) });
          }
        },
      })
    );

    fastify.addHook('onClose', async () => {
      await rateLimiter?.close();
    });
  }

  // Register Policy Engine middleware
  const policyConfig = options.policy ?? config.policy;
  if (policyConfig && (policyConfig.allowedModels !== undefined || policyConfig.maxTokensLimit !== undefined)) {
    fastify.addHook(
      'preHandler',
      createPolicyMiddleware({
        allowedModels: policyConfig.allowedModels,
        maxTokensLimit: policyConfig.maxTokensLimit,
        defaultModel: config.gemini.model,
        skipPaths: skipPublicPaths,
      })
    );
  }

  // Record HTTP request metrics on response
  if (metricsConfig.enabled) {
    fastify.addHook('onResponse', async (request, reply) => {
      const route = normalizeRoute(request);
      const method = request.method;
      const status = String(reply.statusCode);
      const durationSeconds = reply.elapsedTime / 1000;

      metricsRegistry.httpRequestsTotal.inc({ method, route, status });
      metricsRegistry.httpRequestDurationSeconds.observe({ method, route, status }, durationSeconds);
    });
  }

  // Health check endpoint (public - skipped by auth middleware)
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'gateway',
      version: '0.1.0',
    };
  });

  // Prometheus metrics endpoint (public or token-protected)
  fastify.get('/metrics', async (request, reply) => {
    if (!metricsConfig.enabled) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Metrics endpoint is disabled',
        code: 'METRICS_DISABLED',
      });
    }

    if (metricsConfig.authToken) {
      const authHeader = request.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${metricsConfig.authToken}`) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid or missing metrics authorization token',
          code: 'UNAUTHORIZED_METRICS_ACCESS',
        });
      }
    }

    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(metricsRegistry.toPrometheusText());
  });

  // Protected endpoint for testing authentication
  fastify.get('/v1/test-auth', async (request) => {
    return {
      message: 'Authenticated successfully',
      tenantId: request.user?.tenantId,
      apiKeyPrefix: request.user?.apiKeyPrefix,
    };
  });

  // OpenAI-compatible chat completions endpoint
  fastify.post<{ Body: ChatCompletionRequest }>('/v1/chat/completions', async (request, reply) => {
    const body = request.body;

    // Validate request body
    if (!body || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'messages array is required and must not be empty',
        code: 'INVALID_REQUEST',
      });
    }

    // Validate each message has role and content
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

    // Validate requested token count if specified
    const tokenValidation = validateTokenCount(body.max_tokens);
    if (!tokenValidation.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: tokenValidation.error || 'max_tokens must be a positive integer greater than or equal to 1',
        code: 'INVALID_REQUEST',
      });
    }

    // Validate requested temperature if specified
    const tempValidation = validateTemperature(body.temperature);
    if (!tempValidation.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: tempValidation.error || 'temperature must be a number between 0 and 2',
        code: 'INVALID_REQUEST',
      });
    }

    // Handle streaming request (not supported yet)
    if (body.stream === true) {
      return reply.code(501).send({
        error: 'Not Implemented',
        message: 'Streaming is not supported yet',
        code: 'STREAMING_NOT_SUPPORTED',
      });
    }

    const reqIdVal = validateInboundHeader('x-request-id', request.headers['x-request-id']);
    if (!reqIdVal.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: reqIdVal.error,
        code: 'INVALID_HEADER',
      });
    }
    let requestId = reqIdVal.value;
    if (!requestId && request.id) {
      const genId = String(request.id).trim();
      if (genId.length > 0 && genId.length <= 256) {
        requestId = genId;
      }
    }

    const teamIdVal = validateInboundHeader('x-team-id', request.headers['x-team-id']);
    if (!teamIdVal.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: teamIdVal.error,
        code: 'INVALID_HEADER',
      });
    }
    const teamId = teamIdVal.value || request.user?.teamId;

    const workloadIdVal = validateInboundHeader('x-workload-id', request.headers['x-workload-id']);
    if (!workloadIdVal.valid) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: workloadIdVal.error,
        code: 'INVALID_HEADER',
      });
    }
    const workloadId = workloadIdVal.value || request.user?.workloadId;

    // Resolve provider adapter and effective model from requested model
    const resolved = providerRouter.resolve(body?.model);
    if (!resolved) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: `Unsupported model '${body?.model}': no provider adapter configured for this model`,
        code: 'INVALID_REQUEST',
      });
    }

    const { provider, effectiveModel, providerName } = resolved;
    const targetModel = effectiveModel;
    const adaptedBody: ChatCompletionRequest = {
      ...body,
      model: effectiveModel,
    };

    // Check Circuit Breaker before dispatching upstream
    let permit: CircuitBreakerPermit = { allowed: true, isProbe: false, state: 'CLOSED' };
    if (circuitBreaker) {
      permit = circuitBreaker.acquirePermit();
      if (!permit.allowed) {
        if (metricsConfig.enabled) {
          metricsRegistry.providerRequestsTotal.inc({
            provider: providerName,
            model: targetModel,
            status: 'circuit_breaker_open',
          });
          metricsRegistry.providerErrorsTotal.inc({
            provider: providerName,
            model: targetModel,
            type: 'circuit_breaker_open',
          });
        }
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Upstream circuit breaker is OPEN. Fast-failing request.',
          code: 'CIRCUIT_BREAKER_OPEN',
        });
      }
    }

    try {
      const retryConfig = resilienceConfig?.retry;
      const maxRetries = retryConfig ? retryConfig.maxRetries : 0;
      const baseDelayMs = retryConfig ? retryConfig.baseDelayMs : 200;
      const maxDelayMs = retryConfig ? retryConfig.maxDelayMs : 2000;

      const completion = await executeWithRetry({
        fn: () =>
          provider.createChatCompletion(adaptedBody, {
            signal: (request as any).signal || (request.raw as any).signal,
          }),
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        signal: (request as any).signal || (request.raw as any).signal,
        sleep: options.retrySleep,
        onRetry: (retryErr, attempt, delayMs) => {
          request.log.warn(
            { attempt, delayMs, provider: providerName, error: sanitizeErrorMessage(retryErr) },
            'Retrying upstream AI provider request after transient failure'
          );
        },
      });

      if (circuitBreaker) {
        circuitBreaker.recordSuccess(permit);
      }

      if (metricsConfig.enabled) {
        metricsRegistry.providerRequestsTotal.inc({
          provider: providerName,
          model: completion.model,
          status: 'success',
        });
      }

      // Check for trustworthy usage metadata
      // Emit usage event ONLY when trustworthy token usage is available
      if (completion.usage) {
        const inputTokens = completion.usage.prompt_tokens;
        const outputTokens = completion.usage.completion_tokens;

        try {
          const usageEvent = createUsageEvent({
            tenantId: request.user?.tenantId || config.auth.tenantId,
            provider: providerName,
            model: completion.model,
            inputTokens,
            outputTokens,
            requestId,
            teamId,
            workloadId,
          });

          const publishResult = await usagePublisher.publish(usageEvent);
          if (!publishResult.success) {
            request.log.error(
              {
                eventId: usageEvent.eventId,
                stream: config.redis.stream,
                error: publishResult.error,
              },
              'Failed to publish usage event to Redis'
            );
          }
        } catch (publishErr) {
          request.log.error(
            { error: sanitizeErrorMessage(publishErr) },
            'Failed to create or publish usage event'
          );
        }
      } else {
        request.log.info(
          { provider: providerName, model: completion.model },
          'No trustworthy provider usage metadata; skipping usage event emission'
        );
      }

      return completion;
    } catch (err) {
      if (circuitBreaker) {
        circuitBreaker.recordFailure(permit, err);
      }

      // Check if failed call provided trustworthy usage metadata
      const errUsage =
        extractUsageMetadata(err) || (err as any)?.rawUsage || (err as any)?.usage;
      if (
        errUsage &&
        typeof errUsage.inputTokens === 'number' &&
        typeof errUsage.outputTokens === 'number'
      ) {
        try {
          const usageEvent = createUsageEvent({
            tenantId: request.user?.tenantId || config.auth.tenantId,
            provider: providerName,
            model: targetModel,
            inputTokens: errUsage.inputTokens,
            outputTokens: errUsage.outputTokens,
            requestId,
            teamId,
            workloadId,
          });
          const publishResult = await usagePublisher.publish(usageEvent);
          if (!publishResult.success) {
            request.log.error(
              { eventId: usageEvent.eventId, error: publishResult.error },
              'Failed to publish usage event for failed provider call'
            );
          }
        } catch (publishErr) {
          request.log.error(
            { error: sanitizeErrorMessage(publishErr) },
            'Failed to publish usage event for failed provider call'
          );
        }
      }

      // Log error without sensitive data
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      request.log.error({ error: sanitizeErrorMessage(errorMessage), provider: providerName }, 'Provider API error');

      // Check for provider timeout / abort
      const isTimeout =
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
        errorMessage.includes('aborted') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('timed out');
      if (isTimeout) {
        if (metricsConfig.enabled) {
          metricsRegistry.providerRequestsTotal.inc({ provider: providerName, model: targetModel, status: 'timeout' });
          metricsRegistry.providerErrorsTotal.inc({ provider: providerName, model: targetModel, type: 'timeout' });
        }
        return reply.code(504).send({
          error: 'Gateway Timeout',
          message: 'Provider timeout: The upstream provider request timed out',
          code: 'PROVIDER_TIMEOUT',
        });
      }

      // Check for rate limiting
      if (
        errorMessage.includes('429') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('quota')
      ) {
        if (metricsConfig.enabled) {
          metricsRegistry.providerRequestsTotal.inc({ provider: providerName, model: targetModel, status: 'rate_limit' });
          metricsRegistry.providerErrorsTotal.inc({ provider: providerName, model: targetModel, type: 'rate_limit' });
        }
        return reply.code(429).send({
          error: 'Too Many Requests',
          message: 'Provider rate limit exceeded. Please try again later.',
          code: 'PROVIDER_RATE_LIMIT',
        });
      }

      // Check for invalid API key
      if (
        errorMessage.includes('401') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('not configured') ||
        errorMessage.includes('authentication error')
      ) {
        if (metricsConfig.enabled) {
          metricsRegistry.providerRequestsTotal.inc({ provider: providerName, model: targetModel, status: 'auth_error' });
          metricsRegistry.providerErrorsTotal.inc({ provider: providerName, model: targetModel, type: 'auth_error' });
        }
        return reply.code(502).send({
          error: 'Bad Gateway',
          message: 'Invalid provider API key configuration',
          code: 'PROVIDER_AUTH_ERROR',
        });
      }

      // Generic provider error: return sanitized response without leaking raw exceptions or secrets
      if (metricsConfig.enabled) {
        metricsRegistry.providerRequestsTotal.inc({ provider: providerName, model: targetModel, status: 'error' });
        metricsRegistry.providerErrorsTotal.inc({ provider: providerName, model: targetModel, type: 'provider_error' });
      }
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'Provider error: The upstream provider encountered an error while processing the request',
        code: 'PROVIDER_ERROR',
      });
    } finally {
      if (circuitBreaker && permit?.release) {
        permit.release();
      }
    }
  });

  return fastify;
}

async function start() {
  try {
    const config = loadConfig();
    const server = await buildServer({ config, registerSignals: true });
    await server.listen({ port: config.port, host: config.host });
    console.log(`Gateway running on http://${config.host}:${config.port}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only start when executed directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('/dist/index.js') ||
    process.argv[1].endsWith('/src/index.ts'));

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  start();
}