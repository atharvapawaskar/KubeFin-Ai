import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decimal128 } from 'mongodb';
import { generateModelRecommendations, MongoRecommendationSource, type RecommendationUsageRow } from '../src/recommendations.js';
import { parseRecommendationArgs } from '../src/recommendations-cli.js';
import type { PricingRate } from '../src/pricing-catalog.js';

const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-10-01T00:00:00.000Z');
const generations = Array.from({ length: 30 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);

function rows(): RecommendationUsageRow[] {
  return Array.from({ length: 30 }, (_, index) => ({
    tenantId: 'acme',
    teamId: 'ml',
    workloadId: 'summarizer',
    provider: 'provider-a',
    model: 'large',
    currency: 'INR',
    pricingStatus: 'priced',
    windowStart: new Date(from.getTime() + index * 86_400_000).toISOString(),
    eventCount: 1,
    totalInputTokens: 1_000_000,
    totalOutputTokens: 1_000_000,
    costAmount: Decimal128.fromString('6'),
    generation: generations[index]!,
  }));
}

function rates(candidateFrom = from): PricingRate[] {
  return [
    { _id: 'large-rate', pricingVersion: 2, provider: 'provider-a', model: 'large', currency: 'INR', inputRateMicrosPerMillionTokens: 2_000_000, outputRateMicrosPerMillionTokens: 4_000_000, effectiveFrom: from, sourceUrl: 'https://rates.example/large', sourceVerifiedAt: from },
    { _id: 'small-rate', pricingVersion: 2, provider: 'provider-a', model: 'small', currency: 'INR', inputRateMicrosPerMillionTokens: 1_000_000, outputRateMicrosPerMillionTokens: 2_000_000, effectiveFrom: candidateFrom, sourceUrl: 'https://rates.example/small', sourceVerifiedAt: from },
  ];
}

test('generates a reproducible same-provider INR model evaluation with exact savings', () => {
  const result = generateModelRecommendations({ from, to, rows: rows(), pricing: rates(), generations, createdAt: new Date('2026-10-02T00:00:00.000Z') });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.estimatedMonthlySavingsAmount.toString(), '90.000000000000');
  assert.equal(result[0]?.evidence.baselineCostAmount.toString(), '180.000000000000');
  assert.equal(result[0]?.evidence.candidateCostAmount.toString(), '90.000000000000');
  assert.equal(result[0]?.currency, 'INR');
  assert.equal(result[0]?.action.kind, 'evaluate_model');
  assert.deepEqual(result[0]?.evidence.aggregationGenerations, [...generations].sort());
  assert.match(result[0]?.assumptions[1] ?? '', /quality or latency/);
});

test('does not compare currencies, providers, or candidates with incomplete daily rate coverage', () => {
  const mismatched: PricingRate[] = [
    ...rates(),
    { ...rates()[1]!, _id: 'usd-rate', currency: 'USD' },
    { ...rates()[1]!, _id: 'other-provider-rate', provider: 'provider-b' },
  ];
  assert.equal(generateModelRecommendations({ from, to, rows: rows(), pricing: mismatched, generations, createdAt: new Date() }).length, 1);
  assert.equal(generateModelRecommendations({ from, to, rows: rows(), pricing: rates(new Date('2026-09-03T00:00:00.000Z')), generations, createdAt: new Date() }).length, 0);
});

test('does not emit savings when the candidate is not cheaper or workload identity is absent', () => {
  const expensive = rates();
  expensive[1] = { ...expensive[1]!, inputRateMicrosPerMillionTokens: 3_000_000, outputRateMicrosPerMillionTokens: 5_000_000 };
  assert.equal(generateModelRecommendations({ from, to, rows: rows(), pricing: expensive, generations, createdAt: new Date() }).length, 0);
  const unattributed = rows().map((row) => ({ ...row, workloadId: null }));
  assert.equal(generateModelRecommendations({ from, to, rows: unattributed, pricing: rates(), generations, createdAt: new Date() }).length, 0);
});

test('suppresses recommendations when any attributed usage for the workload/model is unpriced', () => {
  const priced = rows()[0]!;
  const unpriced = {
    tenantId: priced.tenantId,
    teamId: priced.teamId,
    workloadId: priced.workloadId,
    provider: priced.provider,
    model: priced.model,
    currency: null,
    pricingStatus: 'unpriced' as const,
    windowStart: priced.windowStart,
    eventCount: priced.eventCount,
    totalInputTokens: priced.totalInputTokens,
    totalOutputTokens: priced.totalOutputTokens,
    generation: priced.generation,
  };
  assert.equal(generateModelRecommendations({ from, to, rows: [...rows(), unpriced], pricing: rates(), generations, createdAt: new Date() }).length, 0);
});

test('requires 30 UTC daily windows and validates CLI arguments without connecting to MongoDB', () => {
  assert.throws(() => generateModelRecommendations({ from, to: new Date('2026-09-30T00:00:00.000Z'), rows: rows(), pricing: rates(), generations, createdAt: new Date() }), /exactly 30/);
  const parsed = parseRecommendationArgs(['--from', '2026-09-01T00:00:00Z', '--to', '2026-10-01T00:00:00Z']);
  assert.equal(parsed.apply, false);
  assert.throws(() => parseRecommendationArgs(['--from', '2026-09-01T00:00:00Z', '--to', '2026-09-30T00:00:00Z']), /exactly 30/);
  assert.throws(() => parseRecommendationArgs(['--from', '2026-09-01T00:00:00+05:30', '--to', '2026-10-01T00:00:00Z']), /UTC midnight/);
});

test('loads only the published generation for each daily window and fails closed when one is missing', async () => {
  let aggregationFilter: Record<string, unknown> | undefined;
  const states = Array.from({ length: 30 }, (_, index) => ({
    _id: `day:${new Date(from.getTime() + index * 86_400_000).toISOString()}`,
    activeGeneration: generations[index]!,
  }));
  const source = new MongoRecommendationSource({
    windows: { find: () => ({ toArray: async () => states }) } as never,
    aggregations: { find: (filter: unknown) => { aggregationFilter = filter as Record<string, unknown>; return { limit: () => ({ toArray: async () => [] }) }; } } as never,
    pricing: { find: () => ({ limit: () => ({ toArray: async () => rates() }) }) } as never,
  });
  const result = await source.load(from, to);
  assert.equal(result.generations.length, 30);
  const alternatives = aggregationFilter?.$or as Array<Record<string, unknown>>;
  assert.equal(alternatives.length, 30);
  assert.equal(alternatives[0]?.generation, generations[0]);

  const missingSource = new MongoRecommendationSource({
    windows: { find: () => ({ toArray: async () => states.slice(1) }) } as never,
    aggregations: { find: () => ({ limit: () => ({ toArray: async () => [] }) }) } as never,
    pricing: { find: () => ({ limit: () => ({ toArray: async () => rates() }) }) } as never,
  });
  await assert.rejects(missingSource.load(from, to), /No published daily aggregation/);
});
