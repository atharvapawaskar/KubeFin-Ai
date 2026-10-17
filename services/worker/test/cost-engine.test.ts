import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCostAmount } from '../src/cost-engine.js';
import type { PricingRate } from '../src/pricing-catalog.js';
import type { UsageEvent } from '../src/usage-event.js';

const event: UsageEvent = {
  schemaVersion: 1,
  eventId: 'd2719f32-43c1-4f42-9b4a-b14b6ad9ac2a',
  occurredAt: '2026-10-17T05:00:00Z',
  tenantId: 'acme',
  provider: 'example-provider',
  model: 'example-model',
  usage: { inputTokens: 120, outputTokens: 45 },
};

const rate: PricingRate = {
  pricingVersion: 2,
  _id: 'example-rate',
  provider: 'example-provider',
  model: 'example-model',
  currency: 'INR',
  inputRateMicrosPerMillionTokens: 1_000_000_000,
  outputRateMicrosPerMillionTokens: 2_000_000_000,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  sourceUrl: 'https://example.invalid/pricing',
  sourceVerifiedAt: new Date('2026-01-01T00:00:00Z'),
};

test('calculates input and output cost exactly and returns Mongo Decimal128', () => {
  assert.equal(calculateCostAmount(event, rate).toString(), '0.210000000000');
});

test('preserves sub-micro-unit precision instead of rounding individual events', () => {
  const halfMicroRate = { ...rate, inputRateMicrosPerMillionTokens: 500_000, outputRateMicrosPerMillionTokens: 0 };
  assert.equal(calculateCostAmount({ ...event, usage: { inputTokens: 1, outputTokens: 0 } }, halfMicroRate).toString(), '5.00000E-7');
});

test('rejects unsafe token counts and unsafe rates', () => {
  assert.throws(
    () => calculateCostAmount({ ...event, usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 } }, rate),
    /safe integers/,
  );
  assert.throws(() => calculateCostAmount(event, { ...rate, inputRateMicrosPerMillionTokens: -1 }), /non-negative/);
});
