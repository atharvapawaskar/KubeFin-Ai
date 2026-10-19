import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { TenantIdentity } from '../types.js';

export interface AuthMiddlewareOptions {
  apiKey: string;
  tenantId: string;
  skipPaths?: string[];
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { apiKey, tenantId, skipPaths = ['/health'] } = options;

  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    // Skip authentication for configured paths
    if (skipPaths.includes(request.url)) {
      return;
    }

    const authHeader = request.headers.authorization;

    // Check for missing Authorization header
    if (!authHeader) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing Authorization header',
        code: 'MISSING_AUTH_HEADER',
      });
    }

    // Check for Bearer token format
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid Authorization header format. Expected: Bearer <API_KEY>',
        code: 'INVALID_AUTH_FORMAT',
      });
    }

    // Validate API key
    if (token !== apiKey) {
      // Log only prefix for security
      const tokenPrefix = token.slice(0, 8);
      request.log.warn({ tokenPrefix }, 'Invalid API key attempted');
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });
    }

    // Resolve and attach tenant identity
    const identity: TenantIdentity = {
      tenantId,
      apiKeyPrefix: token.slice(0, 8),
    };

    request.user = identity;
    request.log.info({ tenantId: identity.tenantId }, 'Request authenticated');
  };
}