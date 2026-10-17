import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UsageStreamConsumer,
  type DeadLetterRecord,
  type PendingEntry,
  type StreamEntry,
  type UsageStreamPort,
} from '../src/stream-consumer.js';
import type { UsageEvent } from '../src/usage-event.js';

const event: UsageEvent = {
  schemaVersion: 1,
  eventId: 'd2719f32-43c1-4f42-9b4a-b14b6ad9ac2a',
  occurredAt: '2026-10-17T05:00:00Z',
  tenantId: 'acme',
  provider: 'openai',
  model: 'example-model',
  usage: { inputTokens: 120, outputTokens: 45 },
};

class FakeStream implements UsageStreamPort {
  readonly calls: string[] = [];
  readonly deadLetters: DeadLetterRecord[] = [];
  readonly acknowledged: string[] = [];
  pendingDeliveries = 1;
  failDeadLetter = false;
  claimed: StreamEntry[] = [];
  fresh: StreamEntry[] = [];
  abortOnRead?: AbortController;

  async createGroup(): Promise<void> {
    this.calls.push('create-group');
  }

  async readNew(): Promise<StreamEntry[]> {
    this.calls.push('read');
    this.abortOnRead?.abort();
    return this.fresh;
  }

  async claimPending(_stream: string, _group: string, _consumer: string, _idle: number, startId: string) {
    this.calls.push(`claim:${startId}`);
    const entries = this.claimed;
    this.claimed = [];
    return { nextId: '0-0', entries, deletedIds: [] };
  }

  async getPending(_stream: string, _group: string, entryId: string): Promise<PendingEntry | undefined> {
    return { id: entryId, deliveries: this.pendingDeliveries, idleMs: 30_000 };
  }

  async acknowledge(_stream: string, _group: string, entryId: string): Promise<void> {
    this.calls.push('ack');
    this.acknowledged.push(entryId);
  }

  async deadLetterAndAcknowledge(
    _stream: string,
    _group: string,
    entryId: string,
    record: DeadLetterRecord,
  ): Promise<void> {
    if (this.failDeadLetter) throw new Error('private Redis detail');
    this.calls.push('dlq+ack');
    this.deadLetters.push(record);
    this.acknowledged.push(entryId);
  }
}

async function runOnce(options: {
  entry: StreamEntry;
  persist?: (event: UsageEvent) => Promise<'inserted' | 'duplicate'>;
  deliveries?: number;
  maxPayloadBytes?: number;
}): Promise<{ stream: FakeStream; logMessages: string[]; outcomes: string[] }> {
  const stream = new FakeStream();
  const controller = new AbortController();
  stream.claimed = [options.entry];
  stream.abortOnRead = controller;
  stream.pendingDeliveries = options.deliveries ?? 1;
  const logMessages: string[] = [];
  const outcomes: string[] = [];
  const consumer = new UsageStreamConsumer({
    stream,
    sink: { persistIdempotently: options.persist ?? (async () => 'inserted') },
    onOutcome: (outcome) => outcomes.push(outcome),
    logger: {
      warn: (_fields, message) => logMessages.push(message),
      error: (_fields, message) => logMessages.push(message),
    },
    config: {
      stream: 'usage-events',
      group: 'kubefin-worker-v1',
      consumer: 'test-consumer',
      batchSize: 10,
      blockMs: 100,
      claimIdleMs: 1_000,
      maxDeliveries: 5,
      maxPayloadBytes: options.maxPayloadBytes ?? 262_144,
    },
  });
  await consumer.run(controller.signal);
  return { stream, logMessages, outcomes };
}

test('recovers a pending event and persists before acknowledgement', async () => {
  const { stream, outcomes } = await runOnce({ entry: { id: '1-0', fields: { payload: JSON.stringify(event) } } });
  assert.deepEqual(stream.calls.slice(0, 3), ['create-group', 'claim:0-0', 'ack']);
  assert.deepEqual(stream.acknowledged, ['1-0']);
  assert.equal(stream.deadLetters.length, 0);
  assert.deepEqual(outcomes, ['inserted']);
});

test('moves an invalid event to the DLQ by digest before acknowledging it without retaining payloads', async () => {
  const raw = JSON.stringify({ ...event, prompt: 'sensitive test value' });
  const { stream, logMessages, outcomes } = await runOnce({ entry: { id: '2-0', fields: { payload: raw } } });
  assert.deepEqual(stream.calls.slice(0, 3), ['create-group', 'claim:0-0', 'dlq+ack']);
  assert.equal(stream.deadLetters[0]?.failureCode, 'INVALID_EVENT_SCHEMA');
  assert.equal(stream.deadLetters[0]?.payload, undefined);
  assert.equal(stream.deadLetters[0]?.payloadBytes, Buffer.byteLength(raw));
  assert.match(stream.deadLetters[0]?.payloadSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(logMessages.some((message) => message.includes('sensitive test value')), false);
  assert.deepEqual(outcomes, ['dead_lettered']);
});

test('leaves a transient persistence failure pending until the delivery limit', async () => {
  const raw = JSON.stringify(event);
  const first = await runOnce({
    entry: { id: '3-0', fields: { payload: raw } },
    persist: async () => { throw new Error('private backend detail'); },
    deliveries: 1,
  });
  assert.equal(first.stream.acknowledged.length, 0);
  assert.equal(first.stream.deadLetters.length, 0);
  assert.deepEqual(first.outcomes, ['retrying']);
  assert.equal(first.logMessages.some((message) => message.includes('private backend detail')), false);

  const exhausted = await runOnce({
    entry: { id: '4-0', fields: { payload: raw } },
    persist: async () => { throw new Error('private backend detail'); },
    deliveries: 5,
  });
  assert.equal(exhausted.stream.deadLetters[0]?.failureCode, 'PERSISTENCE_RETRIES_EXHAUSTED');
  assert.equal(exhausted.stream.deadLetters[0]?.payload, raw);
  assert.deepEqual(exhausted.stream.acknowledged, ['4-0']);
  assert.deepEqual(exhausted.outcomes, ['dead_lettered']);
});

test('does not keep an oversized event body in the DLQ', async () => {
  const raw = 'x'.repeat(2_000);
  const { stream } = await runOnce({
    entry: { id: '5-0', fields: { payload: raw } },
    maxPayloadBytes: 1_024,
  });
  assert.equal(stream.deadLetters[0]?.failureCode, 'INVALID_STREAM_ENVELOPE');
  assert.equal(stream.deadLetters[0]?.payload, undefined);
  assert.equal(stream.deadLetters[0]?.payloadBytes, 2_000);
  assert.match(stream.deadLetters[0]?.payloadSha256 ?? '', /^[a-f0-9]{64}$/);
});

test('does not classify a failed DLQ write as a persistence retry', async () => {
  const stream = new FakeStream();
  const controller = new AbortController();
  stream.claimed = [{ id: '6-0', fields: { payload: '{"broken":true}' } }];
  stream.abortOnRead = controller;
  stream.pendingDeliveries = 5;
  stream.failDeadLetter = true;
  const consumer = new UsageStreamConsumer({
    stream,
    sink: { persistIdempotently: async () => 'inserted' },
    logger: { warn: () => undefined, error: () => undefined },
    config: {
      stream: 'usage-events', group: 'workers', consumer: 'worker-1', batchSize: 10,
      blockMs: 100, claimIdleMs: 1_000, maxDeliveries: 5, maxPayloadBytes: 262_144,
    },
  });

  await consumer.run(controller.signal);
  assert.equal(stream.deadLetters.length, 0);
  assert.equal(stream.acknowledged.length, 0);
  assert.equal(stream.calls.includes('dlq+ack'), false);
});
