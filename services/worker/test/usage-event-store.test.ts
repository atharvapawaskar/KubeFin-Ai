import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoServerError, type Collection } from 'mongodb';
import { MongoUsageEventStore } from '../src/usage-event-store.js';
import type { UsageEventDocument } from '../src/usage-event.js';
import type { PricingCatalog, PricingRate } from '../src/pricing-catalog.js';

const event = {
  schemaVersion: 1 as const,
  eventId: 'd2719f32-43c1-4f42-9b4a-b14b6ad9ac2a',
  occurredAt: '2026-10-17T05:00:00Z',
  tenantId: 'acme',
  provider: 'openai',
  model: 'example-model',
  usage: { inputTokens: 120, outputTokens: 45 },
};

const rate: PricingRate = {
  _id: 'openai-example-model-2026-01',
  provider: 'openai',
  model: 'example-model',
  currency: 'USD',
  inputRateMicroUsdPerMillionTokens: 1_000_000,
  outputRateMicroUsdPerMillionTokens: 2_000_000,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  sourceUrl: 'https://provider.example/pricing',
  sourceVerifiedAt: new Date('2026-01-01T00:00:00Z'),
};

const catalog = (applicable?: PricingRate): PricingCatalog => ({
  findApplicableRate: async () => applicable,
});

test('persists an event with stable identity, cost, pricing provenance, and ingestion metadata', async () => {
  let inserted: UsageEventDocument | undefined;
  const collection = {
    findOne: async () => null,
    updateOne: async () => ({ matchedCount: 0 }),
    insertOne: async (document: UsageEventDocument) => {
      inserted = document;
      return { acknowledged: true, insertedId: document._id };
    },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection, catalog(rate));

  assert.equal(await store.persistIdempotently(event), 'inserted');
  assert.equal(inserted?._id, event.eventId);
  assert.equal('eventId' in (inserted ?? {}), false);
  assert.equal(inserted?.receivedAt, new Date(inserted?.receivedAt ?? '').toISOString());
  assert.equal(inserted?.pricingStatus, 'priced');
  assert.equal(inserted?.cost_usd?.toString(), '0.000210000000');
  assert.equal(inserted?.pricingRecordId, rate._id);
});

test('persists unmatched events as unpriced instead of inventing a cost', async () => {
  let inserted: UsageEventDocument | undefined;
  const collection = {
    findOne: async () => null,
    updateOne: async () => ({ matchedCount: 0 }),
    insertOne: async (document: UsageEventDocument) => { inserted = document; return { acknowledged: true, insertedId: document._id }; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection, catalog());
  assert.equal(await store.persistIdempotently(event), 'unpriced');
  assert.equal(inserted?.pricingStatus, 'unpriced');
  assert.equal('cost_usd' in (inserted ?? {}), false);
});

test('classifies only a duplicate event-id index as an idempotent duplicate', async () => {
  const duplicate = Object.assign(new MongoServerError({ message: 'duplicate' }), {
    code: 11000,
    keyPattern: { _id: 1 },
  });
  const collection = {
    findOne: async () => null,
    updateOne: async () => ({ matchedCount: 0 }),
    insertOne: async () => { throw duplicate; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection, catalog(rate));
  assert.equal(await store.persistIdempotently(event), 'duplicate');
});

test('propagates non-idempotency storage failures', async () => {
  const failure = new Error('storage unavailable');
  const collection = {
    findOne: async () => null,
    updateOne: async () => ({ matchedCount: 0 }),
    insertOne: async () => { throw failure; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection, catalog(rate));
  await assert.rejects(store.persistIdempotently(event), failure);
});

test('backfills a legacy Stage 2 raw event that has not been cost-enriched', async () => {
  let update: { filter: unknown; update: unknown } | undefined;
  const collection = {
    findOne: async () => ({ _id: event.eventId }),
    updateOne: async (filter: unknown, document: unknown) => { update = { filter, update: document }; return { matchedCount: 1 }; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection, catalog(rate));
  assert.equal(await store.persistIdempotently(event), 'inserted');
  assert.deepEqual(update?.filter, { _id: event.eventId, pricingStatus: { $exists: false } });
  assert.equal((update?.update as { $set?: { pricingStatus?: string; pricingRecordId?: string } }).$set?.pricingStatus, 'priced');
  assert.equal((update?.update as { $set?: { pricingStatus?: string; pricingRecordId?: string } }).$set?.pricingRecordId, rate._id);
});

test('reprices a previously unpriced event when an applicable rate is later added', async () => {
  let update: { filter: unknown; update: unknown } | undefined;
  const collection = {
    findOne: async () => ({ _id: event.eventId, pricingStatus: 'unpriced' }),
    updateOne: async (filter: unknown, document: unknown) => { update = { filter, update: document }; return { matchedCount: 1 }; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection, catalog(rate));
  assert.equal(await store.persistIdempotently(event), 'inserted');
  assert.deepEqual(update?.filter, { _id: event.eventId, pricingStatus: 'unpriced' });
  assert.equal((update?.update as { $set?: { pricingStatus?: string } }).$set?.pricingStatus, 'priced');
});
