import assert from 'node:assert/strict';
import test from 'node:test';
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
});

test('uses event identity as the MongoDB idempotency key', () => {
  const document = toUsageEventDocument(usageEventSchema.parse(validEvent), new Date('2026-10-17T06:00:00Z'));
  assert.equal(document._id, validEvent.eventId);
  assert.equal(document.receivedAt, '2026-10-17T06:00:00.000Z');
});
