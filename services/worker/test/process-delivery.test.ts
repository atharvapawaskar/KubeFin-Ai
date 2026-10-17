import assert from 'node:assert/strict';
import test from 'node:test';
import { processDelivery } from '../src/events/process-delivery.js';

test('persists a valid delivery before acknowledging it', async () => {
  const calls: string[] = [];
  const result = await processDelivery(
    { id: 'entry-1', payload: { usage: 3 } },
    {
      validate: (payload) => ({ valid: true, event: payload as { usage: number } }),
      persistIdempotently: async (event) => {
        assert.deepEqual(event, { usage: 3 });
        calls.push('persist');
        return 'inserted';
      },
      deadLetter: async () => assert.fail('valid delivery must not be dead-lettered'),
      acknowledge: async (id) => {
        assert.equal(id, 'entry-1');
        calls.push('acknowledge');
      },
    },
  );

  assert.equal(result, 'inserted');
  assert.deepEqual(calls, ['persist', 'acknowledge']);
});

test('acknowledges a duplicate only after idempotent persistence reports it', async () => {
  const calls: string[] = [];
  const result = await processDelivery(
    { id: 'entry-2', payload: {} },
    {
      validate: () => ({ valid: true, event: {} }),
      persistIdempotently: async () => {
        calls.push('persist');
        return 'duplicate';
      },
      deadLetter: async () => assert.fail('valid delivery must not be dead-lettered'),
      acknowledge: async () => {
        calls.push('acknowledge');
      },
    },
  );

  assert.equal(result, 'duplicate');
  assert.deepEqual(calls, ['persist', 'acknowledge']);
});

test('dead-letters an invalid delivery before acknowledging it', async () => {
  const calls: string[] = [];
  const issues = [{ path: 'usage', message: 'invalid' }];
  const result = await processDelivery(
    { id: 'entry-3', payload: { usage: 'invalid' } },
    {
      validate: () => ({ valid: false, issues }),
      persistIdempotently: async () => assert.fail('invalid delivery must not be persisted'),
      deadLetter: async (delivery, receivedIssues) => {
        assert.equal(delivery.id, 'entry-3');
        assert.deepEqual(receivedIssues, issues);
        calls.push('dead-letter');
      },
      acknowledge: async () => {
        calls.push('acknowledge');
      },
    },
  );

  assert.equal(result, 'dead-lettered');
  assert.deepEqual(calls, ['dead-letter', 'acknowledge']);
});

test('does not acknowledge when persistence fails', async () => {
  let acknowledged = false;
  await assert.rejects(
    processDelivery(
      { id: 'entry-4', payload: {} },
      {
        validate: () => ({ valid: true, event: {} }),
        persistIdempotently: async () => {
          throw new Error('storage unavailable');
        },
        deadLetter: async () => assert.fail('valid delivery must not be dead-lettered'),
        acknowledge: async () => {
          acknowledged = true;
        },
      },
    ),
    /storage unavailable/,
  );
  assert.equal(acknowledged, false);
});

test('does not acknowledge an invalid delivery when the DLQ write fails', async () => {
  let acknowledged = false;
  await assert.rejects(
    processDelivery(
      { id: 'entry-5', payload: {} },
      {
        validate: () => ({ valid: false, issues: [] }),
        persistIdempotently: async () => assert.fail('invalid delivery must not be persisted'),
        deadLetter: async () => {
          throw new Error('DLQ unavailable');
        },
        acknowledge: async () => {
          acknowledged = true;
        },
      },
    ),
    /DLQ unavailable/,
  );
  assert.equal(acknowledged, false);
});
