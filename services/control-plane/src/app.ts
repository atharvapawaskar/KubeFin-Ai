import Fastify, { type FastifyInstance } from 'fastify';
import type { Authenticator, Principal } from './auth.js';
import { InvalidAnalyticsQueryError, InvalidAnalyticsResultError, parseAnalyticsQuery, type MongoAnalyticsRepository } from './analytics.js';

export interface ControlPlaneAppOptions {
  authenticator: Authenticator;
  repository: Pick<MongoAnalyticsRepository, 'spend'>;
  checkReady: () => Promise<void>;
  maxConcurrentRequests?: number;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function createControlPlaneApp(options: ControlPlaneAppOptions): FastifyInstance {
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 64;
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 10_000) {
    throw new Error('maxConcurrentRequests must be an integer between 1 and 10000.');
  }
  const app = Fastify({
    logger: { redact: { paths: ['req.headers.authorization', 'req.url'], censor: '[REDACTED]' } },
    disableRequestLogging: true,
    bodyLimit: 16_384,
  });
  const principals = new WeakMap<object, Principal>();
  const chargedRequests = new WeakSet<object>();
  let inFlight = 0;

  app.addHook('onRequest', async (request, reply) => {
    if (inFlight >= maxConcurrentRequests) {
      reply.header('Retry-After', '1').code(429).send(errorBody('RATE_LIMITED', 'Too many concurrent analytics requests.'));
      return;
    }
    inFlight += 1;
    chargedRequests.add(request);
  });
  app.addHook('onResponse', async (request) => {
    if (chargedRequests.delete(request)) inFlight = Math.max(0, inFlight - 1);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await options.checkReady();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Analytics storage is not ready.'));
    }
  });

  app.get('/api/v2/analytics/spend', {
    preHandler: async (request, reply) => {
      let principal: Principal | null;
      try {
        principal = await options.authenticator.authenticate(request.headers.authorization);
      } catch {
        reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Authentication is temporarily unavailable.'));
        return;
      }
      if (!principal) {
        reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
        return;
      }
      principals.set(request, principal);
    },
  }, async (request, reply) => {
    const principal = principals.get(request);
    if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
    let query;
    try {
      query = parseAnalyticsQuery(request.query);
    } catch (error) {
      const code = error instanceof InvalidAnalyticsQueryError ? error.code : 'INVALID_FILTER';
      return reply.code(400).send(errorBody(code, error instanceof Error ? error.message : 'Invalid analytics query.'));
    }
    if (query.tenantId && !principal.tenantIds.includes(query.tenantId)) {
      return reply.code(403).send(errorBody('FORBIDDEN', 'The requested tenant is outside the authenticated scope.'));
    }
    if (principal.tenantIds.length === 0) return reply.code(403).send(errorBody('FORBIDDEN', 'The authenticated principal has no tenant access.'));
    try {
      return await options.repository.spend(query, principal.tenantIds);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : 0;
      if (statusCode === 403) return reply.code(403).send(errorBody('FORBIDDEN', 'The requested tenant is outside the authenticated scope.'));
      if (error instanceof Error && /cursor/i.test(error.message)) {
        return reply.code(400).send(errorBody('INVALID_CURSOR', 'The cursor is invalid or does not match this query.'));
      }
      if (error instanceof InvalidAnalyticsResultError) {
        return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Analytics data could not be processed.'));
      }
      return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Analytics data is temporarily unavailable.'));
    }
  });

  return app;
}
