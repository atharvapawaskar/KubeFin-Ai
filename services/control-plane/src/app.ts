import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Authenticator, Principal } from './auth.js';
import { InvalidAnalyticsQueryError, InvalidAnalyticsResultError, parseAnalyticsQuery, type MongoAnalyticsRepository } from './analytics.js';
import { DuplicateBudgetError, InvalidBudgetCursorError, InvalidBudgetDataError, InvalidBudgetError, parseBudgetListQuery, type MongoBudgetRepository } from './budgets.js';
import { InvalidRecommendationCursorError, InvalidRecommendationDataError, InvalidRecommendationQueryError, parseRecommendationListQuery, type MongoRecommendationsRepository } from './recommendations.js';

export interface ControlPlaneAppOptions {
  authenticator: Authenticator;
  repository: Pick<MongoAnalyticsRepository, 'spend'>;
  budgets?: MongoBudgetRepository;
  recommendations?: MongoRecommendationsRepository;
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

  const budgetAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let principal: Principal | null;
    try { principal = await options.authenticator.authenticate(request.headers.authorization); }
    catch {
      reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Authentication is temporarily unavailable.'));
      return;
    }
    if (!principal) {
      reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      return;
    }
    if (!principal.tenantIds.length) {
      reply.code(403).send(errorBody('FORBIDDEN', 'The authenticated principal has no tenant access.'));
      return;
    }
    principals.set(request, principal);
  };
  const budgetRepository = options.budgets;
  if (options.recommendations) {
    app.get('/api/v2/recommendations', { preHandler: budgetAuth }, async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      try {
        const query = parseRecommendationListQuery(request.query);
        return await options.recommendations!.list(principal, query);
      } catch (error) {
        if (error instanceof InvalidRecommendationQueryError) return reply.code(400).send(errorBody('INVALID_FILTER', error.message));
        if (error instanceof InvalidRecommendationCursorError) return reply.code(400).send(errorBody('INVALID_CURSOR', error.message));
        if (error instanceof InvalidRecommendationDataError) return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Recommendation data could not be processed.'));
        if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode: unknown }).statusCode) === 403) {
          return reply.code(403).send(errorBody('FORBIDDEN', 'The authenticated principal has no tenant access.'));
        }
        return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Recommendation storage is temporarily unavailable.'));
      }
    });
  }
  if (budgetRepository) {
    app.get('/api/v2/budgets', { preHandler: budgetAuth }, async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      try {
        const query = parseBudgetListQuery(request.query);
        return await budgetRepository.list(principal, query);
      }
      catch (error) {
        if (error instanceof InvalidBudgetError || error instanceof InvalidBudgetCursorError) return reply.code(400).send(errorBody('INVALID_FILTER', error.message));
        if (error instanceof InvalidBudgetDataError) return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Budget data could not be processed.'));
        return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Budget storage is temporarily unavailable.'));
      }
    });
    app.post('/api/v2/budgets', { preHandler: budgetAuth }, async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      try { return reply.code(201).send(await budgetRepository.create(principal, request.body)); }
      catch (error) {
        if (error instanceof InvalidBudgetError) return reply.code(400).send(errorBody('INVALID_BUDGET', error.message));
        if (error instanceof DuplicateBudgetError) return reply.code(409).send(errorBody('BUDGET_CONFLICT', error.message));
        if (error instanceof InvalidBudgetDataError) return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Budget data could not be processed.'));
        return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Budget storage is temporarily unavailable.'));
      }
    });
    app.get<{ Params: { budgetId: string } }>('/api/v2/budgets/:budgetId', { preHandler: budgetAuth }, async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      try {
        const budget = await budgetRepository.get(principal, request.params.budgetId);
        return budget ? budget : reply.code(404).send(errorBody('NOT_FOUND', 'Budget not found.'));
      } catch (error) {
        if (error instanceof InvalidBudgetError) return reply.code(400).send(errorBody('INVALID_BUDGET', error.message));
        if (error instanceof InvalidBudgetDataError) return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Budget data could not be processed.'));
        return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Budget storage is temporarily unavailable.'));
      }
    });
    app.put<{ Params: { budgetId: string } }>('/api/v2/budgets/:budgetId', { preHandler: budgetAuth }, async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      try {
        const budget = await budgetRepository.update(principal, request.params.budgetId, request.body);
        return budget ? budget : reply.code(404).send(errorBody('NOT_FOUND', 'Budget not found.'));
      } catch (error) {
        if (error instanceof InvalidBudgetError) return reply.code(400).send(errorBody('INVALID_BUDGET', error.message));
        if (error instanceof DuplicateBudgetError) return reply.code(409).send(errorBody('BUDGET_CONFLICT', error.message));
        if (error instanceof InvalidBudgetDataError) return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Budget data could not be processed.'));
        return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Budget storage is temporarily unavailable.'));
      }
    });
    app.delete<{ Params: { budgetId: string } }>('/api/v2/budgets/:budgetId', { preHandler: budgetAuth }, async (request, reply) => {
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send(errorBody('UNAUTHENTICATED', 'A valid bearer token is required.'));
      try {
        const deleted = await budgetRepository.delete(principal, request.params.budgetId);
        return deleted ? reply.code(204).send() : reply.code(404).send(errorBody('NOT_FOUND', 'Budget not found.'));
      } catch (error) {
        if (error instanceof InvalidBudgetError) return reply.code(400).send(errorBody('INVALID_BUDGET', error.message));
        return reply.code(503).send(errorBody('DATA_UNAVAILABLE', 'Budget storage is temporarily unavailable.'));
      }
    });
  }

  return app;
}
