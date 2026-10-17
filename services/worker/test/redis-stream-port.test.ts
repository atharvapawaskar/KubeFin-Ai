import assert from 'node:assert/strict';
import test from 'node:test';
import type { RedisClientType } from 'redis';
import { RedisUsageStreamPort } from '../src/redis-stream-port.js';

function fakeClient(methods: Record<string, (...args: never[]) => unknown>): RedisClientType {
  return methods as unknown as RedisClientType;
}

test('creates a group from the beginning and tolerates an existing group', async () => {
  const calls: unknown[][] = [];
  const client = fakeClient({
    xGroupCreate: (async (...args: unknown[]) => {
      calls.push(args);
      throw new Error('BUSYGROUP Consumer Group name already exists');
    }) as (...args: never[]) => unknown,
  });
  const port = new RedisUsageStreamPort(client, 'usage-events:dlq');
  await port.createGroup('usage-events', 'kubefin-worker-v1');
  assert.deepEqual(calls[0], ['usage-events', 'kubefin-worker-v1', '0', { MKSTREAM: true }]);
});

test('reclaims pending stream entries and preserves payload fields', async () => {
  const client = fakeClient({
    xAutoClaim: (async () => ({
      nextId: '0-0',
      messages: [{ id: '10-0', message: { payload: '{"schemaVersion":1}' } }],
      deletedMessages: ['2-0'],
    })) as (...args: never[]) => unknown,
  });
  const port = new RedisUsageStreamPort(client, 'usage-events:dlq');
  const result = await port.claimPending('usage-events', 'workers', 'worker-1', 30_000, '0-0', 10);
  assert.equal(result.entries[0]?.id, '10-0');
  assert.equal(result.entries[0]?.fields.payload, '{"schemaVersion":1}');
  assert.deepEqual(result.deletedIds, ['2-0']);
});

test('uses one Redis script to write the DLQ record only while source is pending and acknowledge it', async () => {
  let script = '';
  let options: unknown;
  const client = fakeClient({
    eval: (async (receivedScript: string, receivedOptions: unknown) => {
      script = receivedScript;
      options = receivedOptions;
      return 1;
    }) as (...args: never[]) => unknown,
  });
  const port = new RedisUsageStreamPort(client, 'usage-events:dlq');
  await port.deadLetterAndAcknowledge('usage-events', 'workers', '10-0', {
    sourceStream: 'usage-events',
    sourceEntryId: '10-0',
    failedAt: '2026-10-17T05:00:00Z',
    failureCode: 'INVALID_EVENT_SCHEMA',
    attempts: 1,
    payload: '{}',
    payloadBytes: 2,
    payloadSha256: 'a'.repeat(64),
  });
  assert.match(script, /XPENDING/);
  assert.match(script, /XADD/);
  assert.match(script, /XACK/);
  assert.deepEqual(options, {
    keys: ['usage-events', 'usage-events:dlq'],
    arguments: ['workers', '10-0', 'usage-events', '2026-10-17T05:00:00Z', 'INVALID_EVENT_SCHEMA', '1', '2', 'a'.repeat(64), '1', '{}'],
  });
});
