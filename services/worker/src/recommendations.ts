import { createHash } from 'node:crypto';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { aggregationWindowId, makeAggregationWindows, type AggregationWindow } from './cost-aggregation.js';
import type { PricingRate } from './pricing-catalog.js';

const DAY_MS = 86_400_000;
const SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const RATE_DENOMINATOR = 1_000_000_000_000n;
const MAX_SOURCE_ROWS = 100_000;
const MAX_PRICING_RECORDS = 10_000;
const MAX_RECOMMENDATIONS = 10_000;
const MODEL_RULE = 'lower_cost_same_provider_model_evaluation_v1' as const;

export interface RecommendationUsageRow {
  tenantId: string;
  teamId: string | null;
  workloadId: string | null;
  provider: string;
  model: string;
  currency: string | null;
  pricingStatus: 'priced' | 'unpriced';
  windowStart: string;
  eventCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costAmount?: Decimal128;
  generation: string;
}

export interface StoredRecommendation extends Document {
  _id: string;
  schemaVersion: 2;
  tenantId: string;
  ruleId: typeof MODEL_RULE;
  type: 'model';
  title: string;
  description: string;
  estimatedMonthlySavingsAmount: Decimal128;
  currency: string;
  affected: {
    provider: string;
    workloadId: string;
    teamId?: string;
    currentModel: string;
    candidateModel: string;
  };
  action: { kind: 'evaluate_model'; from: string; to: string };
  evidence: {
    observedFrom: string;
    observedTo: string;
    observedDays: 30;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    baselineCostAmount: Decimal128;
    candidateCostAmount: Decimal128;
    aggregationGenerations: string[];
    pricingRecordIds: string[];
  };
  assumptions: string[];
  createdAt: string;
}

export interface RecommendationGenerationInput {
  from: Date;
  to: Date;
  rows: readonly RecommendationUsageRow[];
  pricing: readonly PricingRate[];
  generations: readonly string[];
  createdAt: Date;
}

export class InvalidRecommendationSourceError extends Error {}

function parseDecimalUnits(value: unknown): bigint {
  const raw = value instanceof Decimal128 ? value.toString() : String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) throw new InvalidRecommendationSourceError('Recommendation source has an invalid decimal amount.');
  let digits = `${match[1]}${match[2] ?? ''}`;
  let scale = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  if (scale > SCALE || digits.length - scale > 18) throw new InvalidRecommendationSourceError('Recommendation source amount exceeds supported precision.');
  return BigInt(digits) * 10n ** BigInt(SCALE - scale);
}

function decimalFromUnits(units: bigint): Decimal128 {
  if (units < 0n) throw new InvalidRecommendationSourceError('Recommendation cost cannot be negative.');
  const integer = units / SCALE_FACTOR;
  const fraction = (units % SCALE_FACTOR).toString().padStart(SCALE, '0');
  return Decimal128.fromString(`${integer}.${fraction}`);
}

function assertSafeCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidRecommendationSourceError(`Recommendation source ${label} is invalid.`);
}

function rateCoversDay(rate: PricingRate, dayStart: Date): boolean {
  if (!Number.isSafeInteger(rate.inputRateMicrosPerMillionTokens) || rate.inputRateMicrosPerMillionTokens < 0
    || !Number.isSafeInteger(rate.outputRateMicrosPerMillionTokens) || rate.outputRateMicrosPerMillionTokens < 0
    || !rate._id || rate._id.length > 128) {
    throw new InvalidRecommendationSourceError('Recommendation source pricing rate is invalid.');
  }
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  return rate.effectiveFrom <= dayStart && (!rate.effectiveTo || rate.effectiveTo >= dayEnd);
}

function candidateCostUnits(row: RecommendationUsageRow, rate: PricingRate): bigint {
  const numerator = BigInt(row.totalInputTokens) * BigInt(rate.inputRateMicrosPerMillionTokens)
    + BigInt(row.totalOutputTokens) * BigInt(rate.outputRateMicrosPerMillionTokens);
  return (numerator * SCALE_FACTOR) / RATE_DENOMINATOR;
}

function stableId(parts: readonly string[]): string {
  return `rec2_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

function validateRange(from: Date, to: Date): void {
  const windows = makeAggregationWindows(from, to, 'day', 30);
  if (windows.length !== 30) throw new Error('Recommendations require exactly 30 complete UTC daily windows.');
}

export function generateModelRecommendations(input: RecommendationGenerationInput): StoredRecommendation[] {
  validateRange(input.from, input.to);
  if (input.generations.length !== 30 || new Set(input.generations).size !== 30
    || input.generations.some((generation) => !/^[0-9a-f-]{36}$/i.test(generation))) {
    throw new InvalidRecommendationSourceError('A published generation is required for each of the 30 daily windows.');
  }
  const dailyWindows = makeAggregationWindows(input.from, input.to, 'day', 30);
  const generationByWindow = new Map(dailyWindows.map((window, index) => [window.windowStart.toISOString(), input.generations[index]! ]));
  const groups = new Map<string, RecommendationUsageRow[]>();
  const groupsWithUnpricedUsage = new Set<string>();
  for (const row of input.rows) {
    if (!row.tenantId || !row.provider || !row.model || !row.workloadId) continue;
    if (!/^[0-9a-f-]{36}$/i.test(row.generation)) throw new InvalidRecommendationSourceError('Recommendation source row has invalid generation data.');
    if (generationByWindow.get(row.windowStart) !== row.generation) {
      throw new InvalidRecommendationSourceError('Recommendation source row does not match its published daily generation.');
    }
    assertSafeCount(row.eventCount, 'event count');
    assertSafeCount(row.totalInputTokens, 'input token count');
    assertSafeCount(row.totalOutputTokens, 'output token count');
    if (row.eventCount === 0) continue;
    const attributionKey = JSON.stringify([row.tenantId, row.teamId, row.workloadId, row.provider, row.model]);
    if (row.pricingStatus === 'unpriced') {
      groupsWithUnpricedUsage.add(attributionKey);
      continue;
    }
    if (row.pricingStatus !== 'priced' || !/^[A-Z]{3}$/.test(row.currency ?? '') || !(row.costAmount instanceof Decimal128)) {
      throw new InvalidRecommendationSourceError('Recommendation source row has invalid pricing data.');
    }
    parseDecimalUnits(row.costAmount);
    const key = JSON.stringify([row.tenantId, row.teamId, row.workloadId, row.provider, row.model, row.currency]);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  const byProviderCurrency = new Map<string, PricingRate[]>();
  for (const rate of input.pricing) {
    if (rate.pricingVersion !== 2 || !/^[A-Z]{3}$/.test(rate.currency)) continue;
    const key = JSON.stringify([rate.provider, rate.currency]);
    const current = byProviderCurrency.get(key) ?? [];
    current.push(rate);
    byProviderCurrency.set(key, current);
  }

  const recommendations: StoredRecommendation[] = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.windowStart.localeCompare(b.windowStart));
    const first = rows[0]!;
    if (!first.currency || !/^[A-Z]{3}$/.test(first.currency)) continue;
    if (groupsWithUnpricedUsage.has(JSON.stringify([first.tenantId, first.teamId, first.workloadId, first.provider, first.model]))) continue;
    const groupRates = byProviderCurrency.get(JSON.stringify([first.provider, first.currency])) ?? [];
    const baselineUnits = rows.reduce((sum, row) => sum + parseDecimalUnits(row.costAmount), 0n);
    const requests = rows.reduce((sum, row) => sum + row.eventCount, 0);
    const inputTokens = rows.reduce((sum, row) => sum + row.totalInputTokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.totalOutputTokens, 0);
    assertSafeCount(requests, 'request total');
    assertSafeCount(inputTokens, 'input token total');
    assertSafeCount(outputTokens, 'output token total');

    const alternatives = [...new Set(groupRates.map((rate) => rate.model))].filter((model) => model !== first.model).sort();
    for (const candidateModel of alternatives) {
      let candidateUnits = 0n;
      const pricingRecordIds = new Set<string>();
      let covered = true;
      for (const row of rows) {
        const dayStart = new Date(row.windowStart);
        const matches = groupRates.filter((rate) => rate.model === candidateModel && rateCoversDay(rate, dayStart));
        if (matches.length !== 1) { covered = false; break; }
        const rate = matches[0]!;
        candidateUnits += candidateCostUnits(row, rate);
        pricingRecordIds.add(rate._id);
      }
      if (!covered) continue;
      const savingsUnits = baselineUnits - candidateUnits;
      if (savingsUnits <= 0n) continue;
      const parts = [MODEL_RULE, input.from.toISOString(), input.to.toISOString(), first.tenantId,
        first.teamId ?? '', first.workloadId!, first.provider, first.model, candidateModel, first.currency];
      const recommendation: StoredRecommendation = {
        _id: stableId(parts),
        schemaVersion: 2,
        tenantId: first.tenantId,
        ruleId: MODEL_RULE,
        type: 'model',
        title: `Evaluate ${candidateModel} for ${first.workloadId}`,
        description: `The candidate's published ${first.currency} rates produce a lower estimate for this workload's observed token mix. Quality and latency have not been measured.`,
        estimatedMonthlySavingsAmount: decimalFromUnits(savingsUnits),
        currency: first.currency,
        affected: {
          provider: first.provider,
          workloadId: first.workloadId!,
          ...(first.teamId ? { teamId: first.teamId } : {}),
          currentModel: first.model,
          candidateModel,
        },
        action: { kind: 'evaluate_model', from: first.model, to: candidateModel },
        evidence: {
          observedFrom: input.from.toISOString(),
          observedTo: input.to.toISOString(),
          observedDays: 30,
          requests,
          inputTokens,
          outputTokens,
          baselineCostAmount: decimalFromUnits(baselineUnits),
          candidateCostAmount: decimalFromUnits(candidateUnits),
          aggregationGenerations: [...new Set(input.generations)].sort(),
          pricingRecordIds: [...pricingRecordIds].sort(),
        },
        assumptions: [
          'The observed 30-day request volume and token mix are representative of the next 30 days.',
          'The candidate model has not been validated for equivalent quality or latency; run a controlled evaluation before switching.',
        ],
        createdAt: input.createdAt.toISOString(),
      };
      if (recommendations.length >= MAX_RECOMMENDATIONS) {
        throw new InvalidRecommendationSourceError(`Recommendation output exceeds the ${MAX_RECOMMENDATIONS} item safety limit.`);
      }
      recommendations.push(recommendation);
    }
  }
  return recommendations.sort((a, b) => {
    const currencyOrder = a.currency.localeCompare(b.currency);
    if (currencyOrder !== 0) return currencyOrder;
    const aAmount = parseDecimalUnits(a.estimatedMonthlySavingsAmount);
    const bAmount = parseDecimalUnits(b.estimatedMonthlySavingsAmount);
    if (aAmount !== bAmount) return aAmount > bAmount ? -1 : 1;
    return a._id.localeCompare(b._id);
  });
}

export interface RecommendationSourceOptions {
  aggregations: Collection<RecommendationUsageRow>;
  windows: Collection<{ _id: string; activeGeneration: string | null; [key: string]: unknown }>;
  pricing: Collection<PricingRate>;
}

export class MongoRecommendationSource {
  constructor(private readonly options: RecommendationSourceOptions) {}

  async load(from: Date, to: Date): Promise<{ rows: RecommendationUsageRow[]; pricing: PricingRate[]; generations: string[] }> {
    const windows: AggregationWindow[] = makeAggregationWindows(from, to, 'day', 30);
    if (windows.length !== 30) throw new Error('Recommendations require exactly 30 complete UTC daily windows.');
    const ids = windows.map(aggregationWindowId);
    const states = await this.options.windows.find({ _id: { $in: ids }, granularity: 'day' }).toArray();
    const stateById = new Map(states.map((state) => [state._id, state]));
    const generations = windows.map((window) => {
      const state = stateById.get(aggregationWindowId(window));
      if (!state?.activeGeneration) throw new Error(`No published daily aggregation exists for ${window.windowStart.toISOString()}.`);
      return state.activeGeneration;
    });
    const rowCursor = this.options.aggregations.find({
      granularity: 'day',
      $or: windows.map((window, index) => ({ windowStart: window.windowStart.toISOString(), generation: generations[index]! })),
    }).limit(MAX_SOURCE_ROWS + 1);
    const rows = await rowCursor.toArray();
    if (rows.length > MAX_SOURCE_ROWS) throw new Error(`Recommendation source exceeds ${MAX_SOURCE_ROWS} rows; split the run by tenant before retrying.`);
    const pricingCursor = this.options.pricing.find({
      pricingVersion: 2,
      effectiveFrom: { $lt: to },
      $or: [{ effectiveTo: { $gt: from } }, { effectiveTo: { $exists: false } }],
    }).limit(MAX_PRICING_RECORDS + 1);
    const pricing = await pricingCursor.toArray();
    if (pricing.length > MAX_PRICING_RECORDS) throw new Error(`Pricing catalog exceeds ${MAX_PRICING_RECORDS} records for the observation range.`);
    return { rows, pricing, generations };
  }
}

export async function generateAndStoreRecommendations(
  input: RecommendationGenerationInput,
  collection: Collection<StoredRecommendation>,
  apply: boolean,
): Promise<StoredRecommendation[]> {
  const recommendations = generateModelRecommendations(input);
  if (!apply || recommendations.length === 0) return recommendations;
  await collection.bulkWrite(recommendations.map((recommendation) => {
    const { _id, ...values } = recommendation;
    return {
      updateOne: {
        filter: { _id },
        update: { $set: values, $setOnInsert: { _id } },
        upsert: true,
      },
    };
  }), { ordered: false });
  return recommendations;
}

export async function ensureRecommendationIndexes(collection: Collection<StoredRecommendation>): Promise<void> {
  await collection.createIndex(
    { tenantId: 1, currency: 1, estimatedMonthlySavingsAmount: -1, _id: 1 },
    { name: 'recommendations_tenant_currency_savings_v2' },
  );
  await collection.createIndex(
    { 'evidence.observedTo': -1, createdAt: -1 },
    { name: 'recommendations_observation_window_v2' },
  );
}
