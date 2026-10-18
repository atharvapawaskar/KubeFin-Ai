import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { MongoPricingCatalog, type PricingRate } from '../../src/pricing-catalog.js';
import { RedisUsageStreamPort } from '../../src/redis-stream-port.js';
import { UsageStreamConsumer, type ConsumerLogger, type UsageEventSink } from '../../src/stream-consumer.js';
import { MongoUsageEventStore } from '../../src/usage-event-store.js';
import type { UsageEvent, UsageEventDocument } from '../../src/usage-event.js';

const mongoUri = process.env.WORKER_INTEGRATION_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?directConnection=true';
const redisUrl = process.env.WORKER_INTEGRATION_REDIS_URL ?? 'redis://127.0.0.1:6379';

const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2_000, connectTimeoutMS: 2_000 });
const redis = createClient({ url: redisUrl, socket: { connectTimeout: 2_000 } });
redis.on('error', () => undefined);

let databaseName: string;
let streamName: string;
let groupName: string;
let deadLetterStream: string;

before(async () => {
  databaseName = `kubefin_stage10_${randomUUID().replaceAll('-', '')}`;
  streamName = `usage-events:stage10:${randomUUID()}`;
  groupName = `kubefin-worker-stage10-${randomUUID()}`;
  deadLetterStream = `${streamName}:dlq`;
  await mongo.connect();
  await redis.connect();
});

after(async () => {
  if (databaseName) await mongo.db(databaseName).dropDatabase().catch(() => undefined);
  if (redis.isOpen) await redis.del([streamName, deadLetterStream]).catch(() => undefined);
  await Promise.allSettled([mongo.close(), redis.isOpen ? redis.quit() : Promise.resolve()]);
});

test('recovers a transient persistence outage, deduplicates, prices exactly, and dead-letters without payloads', async () => {
  const database = mongo.db(databaseName);
  const events = database.collection<UsageEventDocument>('usage_events');
  const rates = database.collection<PricingRate>('pricing');
  const pricingCatalog = new MongoPricingCatalog(rates, 'INR');
  await pricingCatalog.ensureIndexes();

  const now = new Date();
  const event: UsageEvent = {
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    tenantId: 'stage10-integration',
    provider: 'test-provider',
    model: 'test-model',
    usage: { inputTokens: 120, outputTokens: 45 },
  };
  const rate: PricingRate = {
    _id: `stage10-${event.eventId}`,
    pricingVersion: 2,
    provider: event.provider,
    model: event.model,
    currency: 'INR',
    inputRateMicrosPerMillionTokens: 1_000_000_000,
    outputRateMicrosPerMillionTokens: 2_000_000_000,
    effectiveFrom: new Date(now.getTime() - 60_000),
    sourceUrl: 'https://example.invalid/test-rate',
    sourceVerifiedAt: now,
  };
  await rates.insertOne(rate);

  const eventStore = new MongoUsageEventStore(events, pricingCatalog);
  let firstPersistenceAttempt = true;
  const sink: UsageEventSink = {
    async persistIdempotently(delivered) {
      if (delivered.eventId === event.eventId && firstPersistenceAttempt) {
        firstPersistenceAttempt = false;
        throw new Error('injected transient MongoDB outage');
      }
      return eventStore.persistIdempotently(delivered);
    },
  };

  const stream = new RedisUsageStreamPort(redis, deadLetterStream);
  const outcomes: string[] = [];
  const logged: string[] = [];
  const logger: ConsumerLogger = {
    warn(fields, message) { logged.push(`${message} ${JSON.stringify(fields)}`); },
    error(fields, message) { logged.push(`${message} ${JSON.stringify(fields)}`); },
  };
  const createConsumer = (consumerName: string, signal: AbortSignal) => new UsageStreamConsumer({
    stream,
    sink,
    logger,
    onOutcome: (outcome) => outcomes.push(outcome),
    config: {
      stream: streamName,
      group: groupName,
      consumer: consumerName,
      batchSize: 10,
      blockMs: 100,
      claimIdleMs: 1_000,
      maxDeliveries: 5,
      maxPayloadBytes: 262_144,
    },
  }).run(signal);
  await stream.createGroup(streamName, groupName);
  let controller = new AbortController();
  let consumerTask = createConsumer(`stage10-first-${randomUUID()}`, controller.signal);

  try {
    await redis.xAdd(streamName, '*', { payload: JSON.stringify(event) });
    await waitUntil('transient persistence failure to remain pending', async () => outcomes.includes('retrying'));
    const pendingAfterFailure = await redis.xPendingRange(streamName, groupName, '-', '+', 10);
    assert.equal(pendingAfterFailure.length, 1, 'failed persistence must leave the source entry pending');
    assert.equal(await events.countDocuments({ _id: event.eventId }), 0, 'failed persistence must not create a document');

    controller.abort();
    await consumerTask;
    controller = new AbortController();
    consumerTask = createConsumer(`stage10-restarted-${randomUUID()}`, controller.signal);

    await waitUntil('pending event to be reclaimed and persisted after consumer restart', async () =>
      (await events.countDocuments({ _id: event.eventId })) === 1,
    );
    const stored = await events.findOne({ _id: event.eventId });
    assert.equal(stored?.pricingStatus, 'priced');
    assert.equal(stored?.costCurrency, 'INR');
    assert.equal(stored?.costAmount?.toString(), '0.210000000000');
    assert.equal(stored?.pricingRecordId, rate._id);

    await redis.xAdd(streamName, '*', { payload: JSON.stringify(event) });
    await waitUntil('duplicate delivery to be acknowledged', async () => outcomes.includes('duplicate'));
    assert.equal(await events.countDocuments({ _id: event.eventId }), 1, 'duplicate event IDs must persist once');

    const invalidPayload = JSON.stringify({ prompt: 'stage10-private-prompt-marker' });
    await redis.xAdd(streamName, '*', { payload: invalidPayload });
    await waitUntil('invalid event to be atomically dead-lettered', async () =>
      ((await redis.xRange(deadLetterStream, '-', '+', { COUNT: 10 })) ?? []).length === 1,
    );
    const deadLetters = (await redis.xRange(deadLetterStream, '-', '+', { COUNT: 10 })) ?? [];
    assert.equal(deadLetters[0]?.message.failureCode, 'INVALID_EVENT_SCHEMA');
    assert.equal(deadLetters[0]?.message.payloadBytes, String(Buffer.byteLength(invalidPayload, 'utf8')));
    assert.match(deadLetters[0]?.message.payloadSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal('payload' in (deadLetters[0]?.message ?? {}), false);
    assert.ok(outcomes.includes('inserted'));
    assert.ok(outcomes.includes('dead_lettered'));
    assert.equal(logged.some((line) => line.includes('stage10-private-prompt-marker')), false);
    assert.deepEqual(await redis.xPendingRange(streamName, groupName, '-', '+', 10), []);
  } finally {
    controller.abort();
    await consumerTask;
  }
});

async function waitUntil(description: string, predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
