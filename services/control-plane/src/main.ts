import { MongoClient } from 'mongodb';
import { OidcAuthenticator } from './auth.js';
import { createControlPlaneApp } from './app.js';
import { MongoAnalyticsRepository } from './analytics.js';
import { parseConfig } from './config.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const client = new MongoClient(config.mongoUri, {
    connectTimeoutMS: 2_000,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 30,
    minPoolSize: 2,
    retryReads: true,
  });
  await client.connect();
  const db = client.db(config.mongoDb);
  const repository = new MongoAnalyticsRepository({
    aggregations: db.collection('cost_aggregations'),
    windows: db.collection('cost_aggregation_windows'),
    cursorSigningKey: config.cursorSigningKey,
  });
  await repository.ensureIndexes();
  const authenticator = new OidcAuthenticator({
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    jwksUrl: config.jwtJwksUrl,
    tenantClaim: config.jwtTenantClaim,
  });
  const app = createControlPlaneApp({
    authenticator,
    repository,
    checkReady: async () => { await db.command({ ping: 1 }); },
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  };
  process.once('SIGINT', () => { void close().finally(() => { process.exitCode = 0; }); });
  process.once('SIGTERM', () => { void close().finally(() => { process.exitCode = 0; }); });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`Control Plane startup failed: ${error instanceof Error ? error.message : 'unexpected error'}\n`);
  process.exitCode = 1;
});
