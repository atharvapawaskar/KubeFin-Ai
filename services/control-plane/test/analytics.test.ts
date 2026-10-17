import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { MongoAnalyticsRepository, parseAnalyticsQuery } from '../src/analytics.js';

test('parses aligned, bounded UTC analytics windows and defaults', () => {
  const result = parseAnalyticsQuery({ from: '2026-10-17T00:00:00Z', to: '2026-10-18T00:00:00Z' });
  assert.equal(result.granularity, 'day');
  assert.equal(result.pageSize, 50);
  assert.throws(() => parseAnalyticsQuery({ from: '2026-10-17T00:01:00Z', to: '2026-10-18T00:00:00Z' }), /align/);
  assert.throws(() => parseAnalyticsQuery({ from: '2026-10-17', to: '2026-10-18T00:00:00Z' }), /RFC 3339/);
  assert.throws(() => parseAnalyticsQuery({ from: '2026-10-17T00:00:00Z', to: '2026-10-18T00:00:00Z', unexpected: 'value' }), /Invalid analytics query/);
  assert.throws(() => parseAnalyticsQuery({ from: '2026-10-17T00:00:00Z', to: '2026-10-18T00:00:00Z', cursor: 'x' }), /requires groupBy/);
});

test('rejects unsupported date ranges before reaching MongoDB', () => {
  assert.throws(() => parseAnalyticsQuery({ from: '2026-10-01T00:00:00Z', to: '2026-11-02T00:00:00Z', granularity: 'hour' }), /744 hour windows/);
  assert.throws(() => parseAnalyticsQuery({ from: '2026-10-18T00:00:00Z', to: '2026-10-17T00:00:00Z' }), /earlier/);
});

test('queries only active generations and returns exact currency-separated values', async () => {
  const windowFilters: unknown[] = [];
  const pipelines: Document[][] = [];
  const windows = {
    find: (filter: unknown) => {
      windowFilters.push(filter);
      return { toArray: async () => [{ _id: 'day:2026-10-17T00:00:00.000Z', windowStart: '2026-10-17T00:00:00.000Z', activeGeneration: 'gen-live' }] };
    },
  } as unknown as Collection<{ _id: string; windowStart: string; activeGeneration: string | null }>;
  const aggregations = {
    aggregate: (pipeline: Document[]) => {
      pipelines.push(pipeline);
      const grouping = pipeline.find((stage) => '$group' in stage)?.$group as Document;
      const id = grouping._id as Document;
      if ('bucketStart' in id) return { toArray: async () => [{ bucketStart: '2026-10-17T00:00:00.000Z', currency: 'INR', pricingStatus: 'priced', requests: 2, inputTokens: 11, outputTokens: 5, costAmount: Decimal128.fromString('0.0000003') }] };
      if ('key' in id) return { toArray: async () => [{ key: 'model-a', currency: 'INR', pricingStatus: 'priced', requests: 2, inputTokens: 11, outputTokens: 5, costAmount: Decimal128.fromString('0.0000003'), __sortAmount: Decimal128.fromString('0.0000003') }] };
      return { toArray: async () => [{ currency: 'INR', pricingStatus: 'priced', requests: 2, inputTokens: 11, outputTokens: 5, costAmount: Decimal128.fromString('0.0000003') }] };
    },
  } as unknown as Collection<{ _id: Document }>;
  const repository = new MongoAnalyticsRepository({ aggregations, windows, cursorSigningKey: 'x'.repeat(32) });
  const query = parseAnalyticsQuery({ from: '2026-10-17T00:00:00Z', to: '2026-10-18T00:00:00Z', groupBy: 'model' });
  const response = await repository.spend(query, ['tenant-a']);
  assert.equal((response.totals as Document[])[0]?.costAmount, '0.0000003');
  assert.equal((response.series as Document[])[0]?.currency, 'INR');
  assert.deepEqual(windowFilters[0], {
    _id: { $in: ['day:2026-10-17T00:00:00.000Z'] },
    activeGeneration: { $type: 'string' },
  });
  const match = pipelines[0]?.[0]?.$match as Document;
  assert.deepEqual(match.$or, [{ windowStart: '2026-10-17T00:00:00.000Z', generation: 'gen-live' }]);
  assert.deepEqual(match.tenantId, { $in: ['tenant-a'] });
});

test('rejects tenant scope escalation without querying aggregation data', async () => {
  let aggregateCalls = 0;
  const repository = new MongoAnalyticsRepository({
    windows: { find: () => ({ toArray: async () => [] }) } as unknown as Collection<{ _id: string; windowStart: string; activeGeneration: string | null }>,
    aggregations: { aggregate: () => { aggregateCalls += 1; return { toArray: async () => [] }; } } as unknown as Collection<{ _id: Document }>,
    cursorSigningKey: 'x'.repeat(32),
  });
  const query = parseAnalyticsQuery({ from: '2026-10-17T00:00:00Z', to: '2026-10-18T00:00:00Z', tenantId: 'tenant-b' });
  await assert.rejects(repository.spend(query, ['tenant-a']), (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
  assert.equal(aggregateCalls, 0);
});

test('signs cursors to the query and principal tenant scope', async () => {
  const pageCounts = [
    [
      { key: 'm1', currency: 'INR', pricingStatus: 'priced', requests: 1, inputTokens: 1, outputTokens: 1, costAmount: Decimal128.fromString('0.2') },
      { key: 'm2', currency: 'INR', pricingStatus: 'priced', requests: 1, inputTokens: 1, outputTokens: 1, costAmount: Decimal128.fromString('0.1') },
    ],
    [{ key: 'm2', currency: 'INR', pricingStatus: 'priced', requests: 1, inputTokens: 1, outputTokens: 1, costAmount: Decimal128.fromString('0.1') }],
  ];
  let breakdownRun = 0;
  const repository = new MongoAnalyticsRepository({
    windows: { find: () => ({ toArray: async () => [{ windowStart: '2026-10-17T00:00:00.000Z', activeGeneration: 'gen-live' }] }) } as unknown as Collection<{ _id: string; windowStart: string; activeGeneration: string | null }>,
    aggregations: { aggregate: (pipeline: Document[]) => {
      const id = (pipeline.find((stage) => '$group' in stage)?.$group as Document)?._id as Document;
      if ('key' in id) return { toArray: async () => pageCounts[breakdownRun++] ?? [] };
      return { toArray: async () => [] };
    } } as unknown as Collection<{ _id: Document }>,
    cursorSigningKey: 's'.repeat(32),
  });
  const query = parseAnalyticsQuery({ from: '2026-10-17T00:00:00Z', to: '2026-10-18T00:00:00Z', groupBy: 'model', pageSize: 1 });
  const first = await repository.spend(query, ['tenant-a']);
  const cursor = (first.breakdown as Document).nextCursor as string;
  assert.ok(cursor);
  const second = await repository.spend({ ...query, cursor }, ['tenant-a']);
  assert.equal((second.breakdown as Document).nextCursor, null);
  await assert.rejects(repository.spend({ ...query, cursor }, ['tenant-b']), /Cursor/);
});
