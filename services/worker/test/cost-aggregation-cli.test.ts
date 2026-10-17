import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCostAggregationArgs } from '../src/cost-aggregation-cli.js';

test('parses a dry-run hourly range by default', () => {
  const options = parseCostAggregationArgs([
    '--granularity', 'hour',
    '--from', '2026-10-17T05:00:00Z',
    '--to', '2026-10-17T08:00:00Z',
  ]);
  assert.equal(options.apply, false);
  assert.equal(options.granularity, 'hour');
  assert.equal(options.from.toISOString(), '2026-10-17T05:00:00.000Z');
});

test('requires an explicit apply flag and rejects unknown or duplicate options', () => {
  const args = ['--granularity', 'day', '--from', '2026-10-17T00:00:00Z', '--to', '2026-10-18T00:00:00Z'];
  assert.equal(parseCostAggregationArgs([...args, '--apply']).apply, true);
  assert.throws(() => parseCostAggregationArgs([...args, '--force']), /Unknown option/);
  assert.throws(() => parseCostAggregationArgs([...args, '--from', '2026-10-17T00:00:00Z']), /once/);
  assert.throws(() => parseCostAggregationArgs([...args, '--apply', '--apply']), /once/);
});

test('requires UTC-aligned boundaries and a bounded supported range', () => {
  assert.throws(() => parseCostAggregationArgs([
    '--granularity', 'day', '--from', '2026-10-17T01:00:00Z', '--to', '2026-10-18T00:00:00Z',
  ]), /align/);
  assert.throws(() => parseCostAggregationArgs([
    '--granularity', 'week', '--from', '2026-10-17T00:00:00Z', '--to', '2026-10-24T00:00:00Z',
  ]), /granularity/);
});

test('supports explicit dry-run generation pruning with a past cutoff', () => {
  const options = parseCostAggregationArgs([
    '--granularity', 'day',
    '--from', '2026-10-17T00:00:00Z',
    '--to', '2026-10-19T00:00:00Z',
    '--prune-before', '2026-10-01T00:00:00Z',
  ]);
  assert.equal(options.apply, false);
  assert.equal(options.pruneBefore?.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseCostAggregationArgs([
    '--granularity', 'day', '--from', '2026-10-17T00:00:00Z', '--to', '2026-10-18T00:00:00Z',
    '--prune-before', '2999-01-01T00:00:00Z',
  ]), /past/);
});
