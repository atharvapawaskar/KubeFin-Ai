import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal128 } from 'mongodb';
import { toUsageEventDocument, usageEventSchema } from '../src/usage-event.js';

const validEvent = {
  schemaVersion: 1,
  eventId: 'd2719f32-43c1-4f42-9b4a-b14b6ad9ac2a',
  occurredAt: '2026-10-17T05:00:00Z',
  tenantId: 'acme',
  provider: 'openai',
  model: 'example-model',
  usage: { inputTokens: 120, outputTokens: 45 },
};

test('validates the v1 event shape and optional attribution fields', () => {
  const parsed = usageEventSchema.parse({ ...validEvent, teamId: 'ml', workloadId: 'summarizer' });
  assert.equal(parsed.eventId, validEvent.eventId);
});

test('rejects missing identity, negative usage, and uncontracted sensitive fields', () => {
  assert.equal(usageEventSchema.safeParse({ ...validEvent, eventId: undefined }).success, false);
  assert.equal(usageEventSchema.safeParse({ ...validEvent, usage: { inputTokens: -1, outputTokens: 0 } }).success, false);
  assert.equal(usageEventSchema.safeParse({ ...validEvent, prompt: 'must not be emitted' }).success, false);
  assert.equal(usageEventSchema.safeParse({ ...validEvent, usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 } }).success, false);
});

test('uses event identity as the MongoDB idempotency key and adds pricing metadata', () => {
  const document = toUsageEventDocument(
    usageEventSchema.parse(validEvent),
    { recordId: 'rate-1', costUsd: Decimal128.fromString('0.000123000000000') },
    new Date('2026-10-17T06:00:00Z'),
  );
  assert.equal(document._id, validEvent.eventId);
  assert.equal(document.receivedAt, '2026-10-17T06:00:00.000Z');
  assert.equal(document.pricingStatus, 'priced');
  assert.equal(document.cost_usd?.toString(), Decimal128.fromString('0.000123000000000').toString());
  assert.equal(document.pricingRecordId, 'rate-1');
});

test('stores missing pricing as explicit unpriced metadata', () => {
  const document = toUsageEventDocument(usageEventSchema.parse(validEvent), undefined);
  assert.equal(document.pricingStatus, 'unpriced');
  assert.equal('cost_usd' in document, false);
});
