import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneApp } from '../src/app.js';
import type { Authenticator, Principal } from '../src/auth.js';
import type { MongoAnalyticsRepository } from '../src/analytics.js';

const okPrincipal: Principal = { subject: 'user-a', tenantIds: ['tenant-a'] };

function appFor(options: { principal?: Principal | null; ready?: () => Promise<void>; spend?: (query: unknown, tenants: readonly string[]) => Promise<unknown>; maxConcurrentRequests?: number } = {}) {
  const calls: Array<{ query: unknown; tenants: readonly string[] }> = [];
  const authenticator: Authenticator = { authenticate: async (header) => header === 'Bearer valid' ? (options.principal ?? okPrincipal) : null };
  const repository = { spend: async (query: unknown, tenants: readonly string[]) => {
    calls.push({ query, tenants });
    return options.spend ? options.spend(query, tenants) : { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', granularity: 'day', totals: [], series: [], breakdown: { items: [], nextCursor: null } };
  } } as unknown as MongoAnalyticsRepository;
  const app = createControlPlaneApp({ authenticator, repository, checkReady: options.ready ?? (async () => undefined), ...(options.maxConcurrentRequests ? { maxConcurrentRequests: options.maxConcurrentRequests } : {}) });
  return { app, calls };
}

test('requires bearer auth and blocks tenant escalation before reading spend', async () => {
  const { app, calls } = appFor();
  const missing = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z' });
  assert.equal(missing.statusCode, 401);
  const forbidden = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z&tenantId=tenant-b', headers: { authorization: 'Bearer valid' } });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(calls.length, 0);
  await app.close();
});

test('validates filters and returns the contract response from the repository', async () => {
  const { app, calls } = appFor();
  const invalid = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=bad&to=2026-10-18T00%3A00%3A00Z', headers: { authorization: 'Bearer valid' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).error.code, 'INVALID_RANGE');
  const invalidFilter = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z&currency=usd', headers: { authorization: 'Bearer valid' } });
  assert.equal(invalidFilter.statusCode, 400);
  assert.equal(JSON.parse(invalidFilter.body).error.code, 'INVALID_FILTER');
  const valid = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z&granularity=day&groupBy=model', headers: { authorization: 'Bearer valid' } });
  assert.equal(valid.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.tenants, ['tenant-a']);
  assert.deepEqual(JSON.parse(valid.body), { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', granularity: 'day', totals: [], series: [], breakdown: { items: [], nextCursor: null } });
  await app.close();
});

test('maps authentication dependency and storage failures to safe 503 responses', async () => {
  const authDown: Authenticator = { authenticate: async () => { throw new Error('sensitive endpoint details'); } };
  const appAuthDown = createControlPlaneApp({ authenticator: authDown, repository: { spend: async () => ({}) } as unknown as MongoAnalyticsRepository, checkReady: async () => undefined });
  const authResponse = await appAuthDown.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z' });
  assert.equal(authResponse.statusCode, 503);
  assert.doesNotMatch(authResponse.body, /sensitive endpoint details/);
  await appAuthDown.close();

  const { app } = appFor({ spend: async () => { throw new Error('sensitive database details'); } });
  const dbResponse = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z', headers: { authorization: 'Bearer valid' } });
  assert.equal(dbResponse.statusCode, 503);
  assert.doesNotMatch(dbResponse.body, /sensitive database details/);
  await app.close();
});

test('readiness reflects MongoDB availability', async () => {
  const { app } = appFor({ ready: async () => { throw new Error('unavailable'); } });
  const response = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('limits concurrent analytics requests', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { app } = appFor({ maxConcurrentRequests: 1, spend: async () => { await blocked; return {}; } });
  const first = app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z', headers: { authorization: 'Bearer valid' } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await app.inject({ method: 'GET', url: '/api/v2/analytics/spend?from=2026-10-17T00%3A00%3A00Z&to=2026-10-18T00%3A00%3A00Z', headers: { authorization: 'Bearer valid' } });
  release?.();
  await first;
  assert.equal(second.statusCode, 429);
  await app.close();
});
