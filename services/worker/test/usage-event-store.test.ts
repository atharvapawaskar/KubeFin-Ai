import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoServerError, type Collection } from 'mongodb';
import { MongoUsageEventStore } from '../src/usage-event-store.js';
import type { UsageEventDocument } from '../src/usage-event.js';

const event = {
  schemaVersion: 1 as const,
  eventId: 'd2719f32-43c1-4f42-9b4a-b14b6ad9ac2a',
  occurredAt: '2026-10-17T05:00:00Z',
  tenantId: 'acme',
  provider: 'openai',
  model: 'example-model',
  usage: { inputTokens: 120, outputTokens: 45 },
};

test('persists the raw event with stable idempotency and ingestion metadata', async () => {
  let inserted: UsageEventDocument | undefined;
  const collection = {
    insertOne: async (document: UsageEventDocument) => {
      inserted = document;
      return { acknowledged: true, insertedId: document._id };
    },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection);

  assert.equal(await store.persistIdempotently(event), 'inserted');
  assert.equal(inserted?._id, event.eventId);
  assert.equal('eventId' in (inserted ?? {}), false);
  assert.equal(inserted?.receivedAt, new Date(inserted?.receivedAt ?? '').toISOString());
});

test('classifies only a duplicate event-id index as an idempotent duplicate', async () => {
  const duplicate = Object.assign(new MongoServerError({ message: 'duplicate' }), {
    code: 11000,
    keyPattern: { _id: 1 },
  });
  const collection = {
    insertOne: async () => { throw duplicate; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection);
  assert.equal(await store.persistIdempotently(event), 'duplicate');
});

test('propagates non-idempotency storage failures', async () => {
  const failure = new Error('storage unavailable');
  const collection = {
    insertOne: async () => { throw failure; },
  } as unknown as Collection<UsageEventDocument>;
  const store = new MongoUsageEventStore(collection);
  await assert.rejects(store.persistIdempotently(event), failure);
});
