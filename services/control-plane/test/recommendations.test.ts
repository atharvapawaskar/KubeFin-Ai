import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { createControlPlaneApp } from '../src/app.js';
import type { Authenticator, Principal } from '../src/auth.js';
import type { MongoAnalyticsRepository } from '../src/analytics.js';
import { MongoRecommendationsRepository, parseRecommendationListQuery } from '../src/recommendations.js';

const secret = 'recommendations-cursor-signing-secret-0001';
const principal: Principal = { subject: 'user-a', tenantIds: ['tenant-a'] };

function amountUnits(value: Decimal128): bigint {
  const [integer, fraction = ''] = value.toString().split('.');
  return BigInt(integer ?? '0') * 10n ** 12n + BigInt((fraction + '0'.repeat(12)).slice(0, 12));
}

class MemoryRecommendations {
  docs: Document[] = [];
  async createIndex(): Promise<string> { return 'index'; }
  find(filter: Document) {
    let rows = this.docs.filter((doc) => doc.schemaVersion === filter.schemaVersion
      && filter.tenantId.$in.includes(doc.tenantId)
      && (!filter.currency || doc.currency === filter.currency));
    if (filter.$or) {
      const [currencyAfter, amountBefore, idAfter] = filter.$or as Document[];
      rows = rows.filter((doc) => doc.currency > currencyAfter!.currency.$gt
        || (doc.currency === amountBefore!.currency && amountUnits(doc.estimatedMonthlySavingsAmount as Decimal128) < amountUnits(amountBefore!.estimatedMonthlySavingsAmount.$lt as Decimal128))
        || (doc.currency === idAfter!.currency && amountUnits(doc.estimatedMonthlySavingsAmount as Decimal128) === amountUnits(idAfter!.estimatedMonthlySavingsAmount) && doc._id > idAfter!._id.$gt));
    }
    return {
      sort: () => {
        rows.sort((a, b) => String(a.currency).localeCompare(String(b.currency))
          || (amountUnits(a.estimatedMonthlySavingsAmount as Decimal128) > amountUnits(b.estimatedMonthlySavingsAmount as Decimal128) ? -1 : 1)
          || String(a._id).localeCompare(String(b._id)));
        return { limit: (count: number) => ({ toArray: async () => rows.slice(0, count) }) };
      },
    };
  }
}

function recommendation(id: string, tenantId: string, amount: string, currency = 'INR'): Document {
  const baselineAmount = Decimal128.fromString((Number(amount) + 2).toString());
  return {
    _id: `rec2_${id.padStart(32, '0')}`,
    schemaVersion: 2,
    tenantId,
    ruleId: 'lower_cost_same_provider_model_evaluation_v1',
    type: 'model',
    title: 'Evaluate lower-cost model',
    description: 'Potential price-only opportunity; model quality is not measured.',
    estimatedMonthlySavingsAmount: Decimal128.fromString(amount),
    currency,
    affected: { provider: 'provider-a', workloadId: 'workload-a', currentModel: 'large', candidateModel: 'small' },
    action: { kind: 'evaluate_model', from: 'large', to: 'small' },
    evidence: {
      observedFrom: '2026-09-01T00:00:00.000Z', observedTo: '2026-10-01T00:00:00.000Z', observedDays: 30,
      requests: 12, inputTokens: 120, outputTokens: 60,
      baselineCostAmount: baselineAmount, candidateCostAmount: Decimal128.fromString('2'),
      aggregationGenerations: ['c470e9f5-9d7f-4aa6-a12f-d88cc47102f3'], pricingRecordIds: ['rate-candidate'],
    },
    assumptions: ['Observed usage represents the next 30 days.', 'Quality and latency require controlled evaluation.'],
    createdAt: '2026-10-02T00:00:00.000Z',
  };
}

test('recommendation query rejects unknown filters and bounds pagination', () => {
  assert.deepEqual(parseRecommendationListQuery({ pageSize: '10', currency: 'INR' }), { pageSize: 10, currency: 'INR' });
  assert.throws(() => parseRecommendationListQuery({ pageSize: 101 }));
  assert.throws(() => parseRecommendationListQuery({ tenantId: 'tenant-b' }));
  assert.throws(() => parseRecommendationListQuery({ currency: 'inr' }));
});

test('recommendations are authenticated, tenant-scoped, currency-safe and paginated by exact Decimal128 savings', async () => {
  const memory = new MemoryRecommendations();
  memory.docs.push(
    recommendation('1', 'tenant-a', '10'),
    recommendation('2', 'tenant-a', '20'),
    recommendation('3', 'tenant-a', '5'),
    recommendation('4', 'tenant-b', '999'),
    recommendation('5', 'tenant-a', '100', 'USD'),
  );
  const repository = new MongoRecommendationsRepository(memory as unknown as Collection<Document>, secret);
  const calls: Array<{ principal: Principal; query: unknown }> = [];
  const wrapped = {
    list: async (who: Principal, query: unknown) => { calls.push({ principal: who, query }); return repository.list(who, query as ReturnType<typeof parseRecommendationListQuery>); },
  };
  const authenticator: Authenticator = { authenticate: async (header) => header === 'Bearer valid' ? principal : null };
  const app = createControlPlaneApp({
    authenticator,
    repository: { spend: async () => ({}) } as unknown as MongoAnalyticsRepository,
    recommendations: wrapped as unknown as MongoRecommendationsRepository,
    checkReady: async () => undefined,
  });
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/v2/recommendations' });
  assert.equal(unauthenticated.statusCode, 401);
  const first = await app.inject({ method: 'GET', url: '/api/v2/recommendations?currency=INR&pageSize=2', headers: { authorization: 'Bearer valid' } });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = JSON.parse(first.body) as { items: Array<{ estimatedMonthlySavingsAmount: string }>; nextCursor: string | null };
  assert.deepEqual(firstBody.items.map((item) => item.estimatedMonthlySavingsAmount), ['20', '10']);
  assert.ok(firstBody.nextCursor);
  assert.equal(JSON.stringify(firstBody).includes('tenant-b'), false);
  const second = await app.inject({ method: 'GET', url: `/api/v2/recommendations?currency=INR&pageSize=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, headers: { authorization: 'Bearer valid' } });
  assert.equal(second.statusCode, 200);
  assert.deepEqual((JSON.parse(second.body) as { items: Array<{ estimatedMonthlySavingsAmount: string }> }).items.map((item) => item.estimatedMonthlySavingsAmount), ['5']);
  const replay = await app.inject({ method: 'GET', url: `/api/v2/recommendations?currency=USD&pageSize=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, headers: { authorization: 'Bearer valid' } });
  assert.equal(replay.statusCode, 400);
  assert.deepEqual(calls[0]?.principal.tenantIds, ['tenant-a']);
  await app.close();
});
