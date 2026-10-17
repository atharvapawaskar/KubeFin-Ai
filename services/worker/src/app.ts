import Fastify, { type FastifyInstance } from 'fastify';

export interface HealthDependencies {
  checkReady: () => Promise<void>;
  nodeEnv: 'development' | 'test' | 'production';
}

export function buildHealthApp(dependencies: HealthDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: dependencies.nodeEnv === 'production' ? 'info' : 'debug',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-api-key',
          'res.headers.set-cookie',
        ],
        censor: '[REDACTED]',
      },
    },
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await dependencies.checkReady();
      return { status: 'ready' };
    } catch {
      app.log.warn('Readiness dependency check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  return app;
}
