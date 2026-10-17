import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { buildHealthApp } from './app.js';
import { parseConfig } from './config.js';
import { createMetricsRegistry, createMetricsServer } from './metrics.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const mongo = new MongoClient(config.MONGODB_URI, {
    connectTimeoutMS: 2_000,
    serverSelectionTimeoutMS: 2_000,
    socketTimeoutMS: 3_000,
  });
  const redis = createClient({
    url: config.REDIS_URL,
    socket: {
      connectTimeout: 2_000,
      socketTimeout: 3_000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 3_000) + Math.floor(Math.random() * 100),
    },
  });

  const app = buildHealthApp({
    nodeEnv: config.NODE_ENV,
    checkReady: async () => {
      await Promise.all([mongo.db().admin().command({ ping: 1 }), redis.ping()]);
    },
  });
  redis.on('error', () => app.log.warn('Redis connection error'));

  const metricsServer = createMetricsServer(createMetricsRegistry());
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  let reconnectTask: Promise<void> | undefined;
  let reconnectAttempts = 0;
  const shutdownSignal = new AbortController();

  const reconnectDependencies = async (): Promise<void> => {
    while (!stopping) {
      try {
        if (!redis.isReady) {
          if (!redis.isOpen) await redis.connect();
          await redis.ping();
        }
        await mongo.connect();
        await Promise.all([mongo.db().admin().command({ ping: 1 }), redis.ping()]);
        reconnectAttempts = 0;
        app.log.info('Worker dependencies are ready');
        return;
      } catch {
        app.log.warn('Worker dependencies are unavailable; retrying');
        reconnectAttempts += 1;
        const retryDelayMs = Math.min(250 * 2 ** reconnectAttempts, 5_000) + Math.floor(Math.random() * 250);
        await delay(retryDelayMs, undefined, { signal: shutdownSignal.signal }).catch(() => undefined);
      }
    }
  };

  const closeMetricsServer = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!metricsServer.listening) {
        resolve();
        return;
      }
      metricsServer.close((error) => (error ? reject(error) : resolve()));
    });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownSignal.abort();
    shutdownPromise = (async () => {
      app.log.info('Worker shutdown requested');
      await app.close();
      await closeMetricsServer();
      if (redis.isReady) await redis.close();
      else redis.destroy();
      await reconnectTask;
      await mongo.close();
      app.log.info('Worker shutdown complete');
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown().catch(() => { process.exitCode = 1; }));
  process.once('SIGINT', () => void shutdown().catch(() => { process.exitCode = 1; }));

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  await new Promise<void>((resolve, reject) => {
    metricsServer.once('error', reject);
    metricsServer.listen(config.METRICS_PORT, '0.0.0.0', resolve);
  });
  reconnectTask = reconnectDependencies();
  app.log.info({ port: config.PORT, metricsPort: config.METRICS_PORT }, 'Worker foundation started');
}

main().catch(() => {
  process.stderr.write('Worker failed to start; check configuration and port availability.\n');
  process.exitCode = 1;
});
