import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeAggregationWindows,
  buildCostAggregationPipeline,
  buildInvalidSourceEventsPipeline,
  aggregationWindowId,
  MongoCostAggregationStore,
  type CostAggregationDocument,
  type CostAggregationWindowState,
} from '../src/cost-aggregation.js';
import type { Collection } from 'mongodb';

test('builds bounded UTC hour windows with an exclusive end', () => {
  const windows = makeAggregationWindows(
    new Date('2026-10-17T05:00:00Z'),
    new Date('2026-10-17T08:00:00Z'),
    'hour',
  );
  assert.equal(windows.length, 3);
  assert.equal(windows[0]!.windowEnd.toISOString(), '2026-10-17T06:00:00.000Z');
  assert.equal(aggregationWindowId(windows[1]!), 'hour:2026-10-17T06:00:00.000Z');
});

test('builds a daily window across a daylight-saving boundary as 24 UTC hours', () => {
  const windows = makeAggregationWindows(
    new Date('2026-03-08T00:00:00Z'),
    new Date('2026-03-09T00:00:00Z'),
    'day',
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.windowEnd.getTime() - windows[0]!.windowStart.getTime(), 24 * 60 * 60 * 1000);
});

test('rejects unaligned, reversed, and overly large rollup ranges', () => {
  assert.throws(() => makeAggregationWindows(new Date('2026-10-17T05:30:00Z'), new Date('2026-10-17T06:00:00Z'), 'hour'), /align/);
  assert.throws(() => makeAggregationWindows(new Date('2026-10-17T06:00:00Z'), new Date('2026-10-17T05:00:00Z'), 'hour'), /earlier/);
  assert.throws(() => makeAggregationWindows(new Date('2026-01-01T00:00:00Z'), new Date('2026-02-02T00:00:00Z'), 'hour'), /limit/);
});

test('pipeline separates currencies and unpriced usage and publishes a generation snapshot', () => {
  const window = makeAggregationWindows(new Date('2026-10-17T05:00:00Z'), new Date('2026-10-17T06:00:00Z'), 'hour')[0]!;
  const pipeline = buildCostAggregationPipeline(window, 'c470e9f5-9d7f-4aa6-a12f-d88cc47102f3');
  const group = pipeline.find((stage) => '$group' in stage)?.$group as Record<string, unknown>;
  const id = group._id as Record<string, unknown>;
  assert.deepEqual(id.currency, { $cond: [{ $eq: [{ $ifNull: ['$pricingStatus', 'unpriced'] }, 'priced'] }, '$costCurrency', null] });
  assert.ok(pipeline.some((stage) => '$merge' in stage));
  const projection = pipeline.find((stage) => '$project' in stage)?.$project as Record<string, unknown>;
  assert.deepEqual(projection.costAmount, { $cond: [{ $eq: ['$_id.pricingStatus', 'priced'] }, '$costAmount', '$$REMOVE'] });
  assert.equal((projection.createdAt as { $dateToString: { date: string } }).$dateToString.date, '$$NOW');
  const match = pipeline[0]?.$match as Record<string, { $gte: string; $lt: string }>;
  assert.equal(match.occurredAt!.$gte, '2026-10-16T00:00:00');
  assert.equal(match.occurredAt!.$lt, '2026-10-19T00:00:00');
});

test('preflight pipeline rejects malformed timestamps, dimensions, cost, or token fields', () => {
  const window = makeAggregationWindows(new Date('2026-10-17T05:00:00Z'), new Date('2026-10-17T06:00:00Z'), 'hour')[0]!;
  const pipeline = buildInvalidSourceEventsPipeline(window);
  const invalidMatch = pipeline.find((stage) => '$match' in stage && '$expr' in stage.$match)?.$match as { $expr: unknown };
  assert.ok(invalidMatch.$expr);
  assert.ok(pipeline.some((stage) => '$match' in stage && '$or' in stage.$match));
  assert.ok(pipeline.some((stage) => '$count' in stage));
});

test('publishes a complete new generation only after aggregation succeeds', async () => {
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  let aggregateCalls = 0;
  const events = {
    aggregate: () => {
      aggregateCalls += 1;
      return aggregateCalls === 1
        ? { next: async () => null }
        : { toArray: async () => [] };
    },
  } as unknown as Collection;
  const aggregations = {} as Collection<CostAggregationDocument>;
  const windows = {
    updateOne: async (filter: unknown, update: unknown) => {
      updates.push({ filter, update });
      return updates.length === 1 ? { matchedCount: 0, upsertedCount: 1 } : { matchedCount: 1, upsertedCount: 0 };
    },
    findOne: async () => ({ leaseFence: 1 }),
  } as unknown as Collection<CostAggregationWindowState>;
  const store = new MongoCostAggregationStore(events, aggregations, windows);
  const window = makeAggregationWindows(new Date('2026-10-17T05:00:00Z'), new Date('2026-10-17T06:00:00Z'), 'hour')[0]!;

  assert.equal(await store.rebuildWindow(window), 'published');
  assert.equal(aggregateCalls, 2);
  const publication = updates[2]?.update as { $set?: { activeGeneration?: string }; $unset?: Record<string, string> };
  assert.match(publication.$set?.activeGeneration ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(publication.$unset && 'leaseOwner' in publication.$unset);
});

test('refuses to publish when source records violate event or pricing invariants', async () => {
  const updates: Array<{ update: unknown }> = [];
  let aggregateCalls = 0;
  const events = {
    aggregate: () => {
      aggregateCalls += 1;
      return { next: async () => ({ invalidCount: 1 }) };
    },
  } as unknown as Collection;
  const aggregations = { deleteMany: async () => ({ deletedCount: 0 }) } as unknown as Collection<CostAggregationDocument>;
  const windows = {
    updateOne: async (_filter: unknown, update: unknown) => {
      updates.push({ update });
      return updates.length === 1 ? { matchedCount: 0, upsertedCount: 1 } : { matchedCount: 1, upsertedCount: 0 };
    },
    findOne: async () => ({ leaseFence: 1 }),
  } as unknown as Collection<CostAggregationWindowState>;
  const store = new MongoCostAggregationStore(events, aggregations, windows);
  const window = makeAggregationWindows(new Date('2026-10-17T05:00:00Z'), new Date('2026-10-17T06:00:00Z'), 'hour')[0]!;

  await assert.rejects(store.rebuildWindow(window), /invalid source event/);
  assert.equal(aggregateCalls, 1);
  assert.equal(updates.length, 2);
  assert.ok((updates[1]?.update as { $set?: { leaseOwner?: null } }).$set?.leaseOwner === null);
});

test('queries only the published generation for each window and preserves currency rows', async () => {
  const resultRows = [
    { currency: 'INR', pricingStatus: 'priced', costAmount: { toString: () => '1.25' } },
    { currency: 'USD', pricingStatus: 'priced', costAmount: { toString: () => '0.5' } },
  ];
  let aggregateFilter: unknown;
  const windows = {
    find: () => ({ toArray: async () => [
      { _id: 'hour:2026-10-17T05:00:00.000Z', windowStart: '2026-10-17T05:00:00.000Z', activeGeneration: 'generation-a' },
      { _id: 'hour:2026-10-17T06:00:00.000Z', windowStart: '2026-10-17T06:00:00.000Z', activeGeneration: 'generation-b' },
    ] }),
  } as unknown as Collection<CostAggregationWindowState>;
  const aggregations = {
    find: (filter: unknown) => {
      aggregateFilter = filter;
      return { sort: () => ({ toArray: async () => resultRows }) };
    },
  } as unknown as Collection<CostAggregationDocument>;
  const store = new MongoCostAggregationStore({} as Collection, aggregations, windows);

  const rows = await store.queryActiveRange(
    new Date('2026-10-17T05:00:00Z'),
    new Date('2026-10-17T07:00:00Z'),
    'hour',
  );
  assert.equal(rows.length, 2);
  assert.deepEqual((aggregateFilter as { $or: unknown[] }).$or, [
    { windowStart: '2026-10-17T05:00:00.000Z', generation: 'generation-a' },
    { windowStart: '2026-10-17T06:00:00.000Z', generation: 'generation-b' },
  ]);
  assert.deepEqual(rows.map((row) => row.currency), ['INR', 'USD']);
});
