import assert from 'node:assert/strict';
import test from 'node:test';
import type { Collection } from 'mongodb';
import { MongoPricingCatalog, type PricingRate } from '../src/pricing-catalog.js';

const rate: PricingRate = {
  _id: 'rate-1', provider: 'openai', model: 'example-model', currency: 'USD',
  inputRateMicroUsdPerMillionTokens: 1_000_000, outputRateMicroUsdPerMillionTokens: 2_000_000,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'), sourceUrl: 'https://example.invalid/pricing',
  sourceVerifiedAt: new Date('2026-01-01T00:00:00Z'),
};

function event(occurredAt: string) {
  return {
    schemaVersion: 1 as const, eventId: 'd2719f32-43c1-4f42-9b4a-b14b6ad9ac2a', occurredAt,
    tenantId: 'acme', provider: 'openai', model: 'example-model', usage: { inputTokens: 1, outputTokens: 1 },
  };
}

test('looks up a provider/model rate applicable at event time', async () => {
  let query: Record<string, unknown> | undefined;
  const cursor = {
    sort: () => cursor,
    limit: () => cursor,
    toArray: async () => [rate],
  };
  const collection = { find: (filter: Record<string, unknown>) => { query = filter; return cursor; } } as unknown as Collection<PricingRate>;
  const catalog = new MongoPricingCatalog(collection);
  assert.equal((await catalog.findApplicableRate(event('2026-10-17T05:00:00Z')))?._id, rate._id);
  assert.equal(query?.provider, 'openai');
  assert.equal(query?.model, 'example-model');
  assert.deepEqual(query?.effectiveFrom, { $lte: new Date('2026-10-17T05:00:00Z') });
});

test('rejects overlapping active rates instead of choosing an arbitrary price', async () => {
  const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => [rate, { ...rate, _id: 'rate-2' }] };
  const collection = { find: () => cursor } as unknown as Collection<PricingRate>;
  const catalog = new MongoPricingCatalog(collection);
  await assert.rejects(catalog.findApplicableRate(event('2026-10-17T05:00:00Z')), /intervals overlap/);
});

test('creates a unique provider/model/effective-from index', async () => {
  let captured: unknown;
  const collection = { createIndex: async (keys: unknown, options: unknown) => { captured = { keys, options }; return 'index'; } } as unknown as Collection<PricingRate>;
  const catalog = new MongoPricingCatalog(collection);
  await catalog.ensureIndexes();
  assert.deepEqual(captured, {
    keys: { provider: 1, model: 1, effectiveFrom: 1 },
    options: { unique: true, name: 'pricing_provider_model_effective_from_unique' },
  });
});
