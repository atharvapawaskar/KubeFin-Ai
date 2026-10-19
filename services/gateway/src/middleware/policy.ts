import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ChatCompletionRequest } from '../providers/gemini.js';

export interface PolicyMiddlewareOptions {
  allowedModels?: string[];
  maxTokensLimit?: number;
  defaultModel?: string;
  skipPaths?: string[];
}

export function isModelAllowed(
  requestedModel: string | undefined,
  allowedModels: string[] | undefined,
  defaultModel?: string
): boolean {
  if (!allowedModels || allowedModels.length === 0) {
    return true;
  }
  let effectiveModel: string | undefined;
  if (requestedModel !== undefined && requestedModel !== null) {
    effectiveModel = typeof requestedModel === 'string' ? requestedModel.trim() : String(requestedModel);
  } else if (defaultModel !== undefined && defaultModel !== null) {
    effectiveModel = typeof defaultModel === 'string' ? defaultModel.trim() : String(defaultModel);
  }

  if (!effectiveModel || effectiveModel.length === 0) {
    return false;
  }

  return allowedModels.includes(effectiveModel);
}

export function isMaxTokensExceeded(
  requestedTokens: unknown,
  maxTokensLimit: number | undefined
): boolean {
  if (maxTokensLimit === undefined || maxTokensLimit === null) {
    return false;
  }
  const tokens =
    typeof requestedTokens === 'number'
      ? requestedTokens
      : typeof requestedTokens === 'string' && /^\d+$/.test(requestedTokens.trim())
        ? parseInt(requestedTokens.trim(), 10)
        : undefined;

  if (typeof tokens !== 'number') {
    return false;
  }
  return tokens > maxTokensLimit;
}

export function createPolicyMiddleware(options: PolicyMiddlewareOptions) {
  const { allowedModels, maxTokensLimit, defaultModel, skipPaths = ['/health', '/metrics'] } = options;

  const hasAllowedModels = Array.isArray(allowedModels) && allowedModels.length > 0;
  const hasMaxTokensLimit = typeof maxTokensLimit === 'number' && maxTokensLimit > 0;

  if (!hasAllowedModels && !hasMaxTokensLimit) {
    return async function noopPolicyMiddleware() {};
  }

  const allowedSet = hasAllowedModels ? new Set(allowedModels) : null;

  return async function policyMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    const route = request.routeOptions?.url || request.url;
    if (skipPaths.includes(request.url) || (route && skipPaths.includes(route))) {
      return;
    }

    if (request.method !== 'POST') {
      return;
    }
    const isChatRoute = route === '/v1/chat/completions' || request.url.startsWith('/v1/chat/completions');
    if (!isChatRoute) {
      return;
    }

    const body = request.body as ChatCompletionRequest | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return;
    }

    // 1. Model allow-list enforcement (HTTP 403 MODEL_NOT_ALLOWED)
    if (allowedSet) {
      const modelExplicitlySpecified = body.model !== undefined && body.model !== null;
      let effectiveModel: string | undefined;

      if (modelExplicitlySpecified) {
        effectiveModel = typeof body.model === 'string' ? body.model.trim() : String(body.model);
      } else {
        effectiveModel = typeof defaultModel === 'string' ? defaultModel.trim() : undefined;
      }

      if (!effectiveModel || !allowedSet.has(effectiveModel)) {
        const rejectedModel = modelExplicitlySpecified ? String(body.model) : (defaultModel || 'unknown');
        return reply.code(403).send({
          error: 'Forbidden',
          message: `Model '${rejectedModel}' is not allowed`,
          code: 'MODEL_NOT_ALLOWED',
        });
      }
    }

    // 2. Maximum requested output tokens ceiling enforcement (HTTP 400 MAX_TOKENS_EXCEEDED)
    if (hasMaxTokensLimit) {
      const rawTokens: unknown = body.max_tokens;
      const requestedTokens =
        typeof rawTokens === 'number'
          ? rawTokens
          : typeof rawTokens === 'string' && /^\d+$/.test(rawTokens.trim())
            ? parseInt(rawTokens.trim(), 10)
            : undefined;

      if (typeof requestedTokens === 'number' && requestedTokens > maxTokensLimit) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Requested max_tokens (${requestedTokens}) exceeds maximum permitted limit of ${maxTokensLimit}`,
          code: 'MAX_TOKENS_EXCEEDED',
        });
      }
    }
  };
}
