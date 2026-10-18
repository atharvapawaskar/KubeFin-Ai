import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { z } from 'zod';
import type { Principal } from './auth.js';

const querySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

export interface RecommendationListQuery {
  currency?: string;
  pageSize: number;
  cursor?: string;
}

export interface RecommendationItem extends Document {
  id: string;
  schemaVersion: 2;
  tenantId: string;
  ruleId: 'lower_cost_same_provider_model_evaluation_v1';
  type: 'model';
  title: string;
  description: string;
  estimatedMonthlySavingsAmount: string;
  currency: string;
  affected: Document;
  action: Document;
  evidence: Document;
  assumptions: string[];
  createdAt: string;
}

export interface RecommendationPage { items: RecommendationItem[]; nextCursor: string | null }

export class InvalidRecommendationQueryError extends Error {}
export class InvalidRecommendationCursorError extends Error {}
export class InvalidRecommendationDataError extends Error {}

interface RecommendationCursor {
  v: 1;
  tenantHash: string;
  filterHash: string;
  currency: string;
  amount: string;
  id: string;
}

function tenantHash(tenantIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...new Set(tenantIds)].sort())).digest('base64url');
}

function filterHash(query: RecommendationListQuery): string {
  return createHash('sha256').update(JSON.stringify({ currency: query.currency ?? null, pageSize: query.pageSize })).digest('base64url');
}

function signCursor(payload: RecommendationCursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function verifyCursor(value: string, secret: string, expectedTenants: string, expectedFilters: string): RecommendationCursor {
  if (value.length > 2048) throw new InvalidRecommendationCursorError('Invalid recommendation cursor.');
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) throw new InvalidRecommendationCursorError('Invalid recommendation cursor.');
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new InvalidRecommendationCursorError('Invalid recommendation cursor.');
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<RecommendationCursor>;
    if (payload.v !== 1 || payload.tenantHash !== expectedTenants || payload.filterHash !== expectedFilters
      || typeof payload.currency !== 'string' || !/^[A-Z]{3}$/.test(payload.currency)
      || typeof payload.amount !== 'string' || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(payload.amount)
      || typeof payload.id !== 'string' || !/^rec2_[a-f0-9]{32}$/.test(payload.id)) {
      throw new InvalidRecommendationCursorError('Recommendation cursor does not match this query.');
    }
    return payload as RecommendationCursor;
  } catch (error) {
    if (error instanceof InvalidRecommendationCursorError) throw error;
    throw new InvalidRecommendationCursorError('Invalid recommendation cursor.');
  }
}

function decimalString(value: unknown): string {
  if (!(value instanceof Decimal128)) throw new InvalidRecommendationDataError('Stored recommendation amount is not Decimal128.');
  const raw = value.toString();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) throw new InvalidRecommendationDataError('Stored recommendation amount is invalid.');
  let digits = `${match[1]}${match[2] ?? ''}`;
  let scale = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  if (scale > 12 || digits.length - scale > 18) throw new InvalidRecommendationDataError('Stored recommendation amount exceeds the API precision.');
  if (!/[1-9]/.test(digits)) return '0';
  if (raw.startsWith('-')) throw new InvalidRecommendationDataError('Stored recommendation amount cannot be negative.');
  if (digits.length <= scale) digits = `${'0'.repeat(scale - digits.length + 1)}${digits}`;
  const point = digits.length - scale;
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const fraction = scale ? digits.slice(point).replace(/0+$/, '') : '';
  return fraction ? `${integer}.${fraction}` : integer;
}

function decimalUnits(value: unknown): bigint {
  const canonical = decimalString(value);
  const [integer, fraction = ''] = canonical.split('.');
  return BigInt(integer ?? '0') * (10n ** 12n) + BigInt((fraction + '0'.repeat(12)).slice(0, 12));
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new InvalidRecommendationDataError('Stored recommendation text is invalid.');
  return value;
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidRecommendationDataError('Stored recommendation evidence count is invalid.');
  return value;
}

function dateString(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new InvalidRecommendationDataError('Stored recommendation timestamp is invalid.');
  }
  return new Date(value).toISOString();
}

function mapRecommendation(doc: Document, allowed: ReadonlySet<string>): RecommendationItem {
  const id = requiredString(doc._id, 256);
  const tenantId = requiredString(doc.tenantId, 256);
  if (!/^rec2_[a-f0-9]{32}$/.test(id) || !allowed.has(tenantId) || doc.schemaVersion !== 2
    || doc.ruleId !== 'lower_cost_same_provider_model_evaluation_v1' || doc.type !== 'model') {
    throw new InvalidRecommendationDataError('Stored recommendation identity is invalid.');
  }
  if (typeof doc.affected !== 'object' || doc.affected === null || Array.isArray(doc.affected)
    || typeof doc.action !== 'object' || doc.action === null || Array.isArray(doc.action)
    || typeof doc.evidence !== 'object' || doc.evidence === null || Array.isArray(doc.evidence)) {
    throw new InvalidRecommendationDataError('Stored recommendation evidence is invalid.');
  }
  const affected = doc.affected as Document;
  const action = doc.action as Document;
  const evidence = doc.evidence as Document;
  const currency = requiredString(doc.currency, 3);
  if (!/^[A-Z]{3}$/.test(currency) || action.kind !== 'evaluate_model') throw new InvalidRecommendationDataError('Stored recommendation currency or action is invalid.');
  const generations = evidence.aggregationGenerations;
  const pricingIds = evidence.pricingRecordIds;
  const assumptions = doc.assumptions;
  if (!Array.isArray(generations) || generations.length < 1 || generations.length > 30
    || !generations.every((item) => typeof item === 'string' && /^[0-9a-f-]{36}$/i.test(item))
    || !Array.isArray(pricingIds) || pricingIds.length < 1 || pricingIds.length > 62
    || !pricingIds.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128)
    || !Array.isArray(assumptions) || assumptions.length < 1 || assumptions.length > 20
    || !assumptions.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 512)) {
    throw new InvalidRecommendationDataError('Stored recommendation provenance is invalid.');
  }
  if (evidence.observedDays !== 30) throw new InvalidRecommendationDataError('Stored recommendation period is invalid.');
  const mappedEvidence: Document = {
    observedFrom: dateString(evidence.observedFrom),
    observedTo: dateString(evidence.observedTo),
    observedDays: 30,
    requests: safeCount(evidence.requests),
    inputTokens: safeCount(evidence.inputTokens),
    outputTokens: safeCount(evidence.outputTokens),
    baselineCostAmount: decimalString(evidence.baselineCostAmount),
    candidateCostAmount: decimalString(evidence.candidateCostAmount),
    aggregationGenerations: [...generations],
    pricingRecordIds: [...pricingIds],
  };
  const observedFrom = new Date(mappedEvidence.observedFrom as string);
  const observedTo = new Date(mappedEvidence.observedTo as string);
  if (observedFrom.getUTCHours() !== 0 || observedFrom.getUTCMinutes() !== 0 || observedFrom.getUTCSeconds() !== 0
    || observedFrom.getUTCMilliseconds() !== 0 || observedTo.getTime() - observedFrom.getTime() !== 30 * 86_400_000
    || safeCount(evidence.requests) < 1) {
    throw new InvalidRecommendationDataError('Stored recommendation observation window is invalid.');
  }
  if (action.from !== affected.currentModel || action.to !== affected.candidateModel) {
    throw new InvalidRecommendationDataError('Stored recommendation action does not match its affected models.');
  }
  const savings = decimalUnits(doc.estimatedMonthlySavingsAmount);
  const baseline = decimalUnits(evidence.baselineCostAmount);
  const candidate = decimalUnits(evidence.candidateCostAmount);
  if (savings <= 0n || baseline <= candidate || baseline - candidate !== savings) {
    throw new InvalidRecommendationDataError('Stored recommendation savings do not match its evidence.');
  }
  return {
    id,
    schemaVersion: 2,
    tenantId,
    ruleId: 'lower_cost_same_provider_model_evaluation_v1',
    type: 'model',
    title: requiredString(doc.title, 160),
    description: requiredString(doc.description, 2000),
    estimatedMonthlySavingsAmount: decimalString(doc.estimatedMonthlySavingsAmount),
    currency,
    affected: {
      provider: requiredString(affected.provider, 128),
      workloadId: requiredString(affected.workloadId, 256),
      ...(typeof affected.teamId === 'string' ? { teamId: requiredString(affected.teamId, 256) } : {}),
      currentModel: requiredString(affected.currentModel, 256),
      candidateModel: requiredString(affected.candidateModel, 256),
    },
    action: {
      kind: 'evaluate_model',
      from: requiredString(action.from, 256),
      to: requiredString(action.to, 256),
    },
    evidence: mappedEvidence,
    assumptions: [...assumptions],
    createdAt: dateString(doc.createdAt),
  };
}

export function parseRecommendationListQuery(raw: unknown): RecommendationListQuery {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw new InvalidRecommendationQueryError('Invalid recommendation list filters.');
  return {
    pageSize: parsed.data.pageSize,
    ...(parsed.data.currency ? { currency: parsed.data.currency } : {}),
    ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
  };
}

export class MongoRecommendationsRepository {
  constructor(private readonly collection: Collection<Document>, private readonly cursorSigningKey: string) {
    if (Buffer.byteLength(cursorSigningKey) < 32) throw new Error('Recommendation cursor signing key must be at least 32 bytes.');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { tenantId: 1, currency: 1, estimatedMonthlySavingsAmount: -1, _id: 1 },
      { name: 'recommendations_tenant_currency_savings_v2' },
    );
    await this.collection.createIndex(
      { 'evidence.observedTo': -1, createdAt: -1 },
      { name: 'recommendations_observation_window_v2' },
    );
  }

  async list(principal: Principal, query: RecommendationListQuery): Promise<RecommendationPage> {
    const tenantIds = [...new Set(principal.tenantIds)].sort();
    if (!tenantIds.length) throw Object.assign(new Error('No authorized tenant scope.'), { statusCode: 403 });
    const tenants = tenantHash(tenantIds);
    const filters = filterHash(query);
    const cursor = query.cursor ? verifyCursor(query.cursor, this.cursorSigningKey, tenants, filters) : undefined;
    const filter: Document = { schemaVersion: 2, tenantId: { $in: tenantIds }, ...(query.currency ? { currency: query.currency } : {}) };
    if (cursor) {
      const amount = Decimal128.fromString(cursor.amount);
      filter.$or = [
        { currency: { $gt: cursor.currency } },
        { currency: cursor.currency, estimatedMonthlySavingsAmount: { $lt: amount } },
        { currency: cursor.currency, estimatedMonthlySavingsAmount: amount, _id: { $gt: cursor.id } },
      ];
    }
    const rows = await this.collection.find(filter)
      .sort({ currency: 1, estimatedMonthlySavingsAmount: -1, _id: 1 })
      .limit(query.pageSize + 1)
      .toArray();
    const hasMore = rows.length > query.pageSize;
    const pageRows = hasMore ? rows.slice(0, query.pageSize) : rows;
    const allowed = new Set(tenantIds);
    const items = pageRows.map((row) => mapRecommendation(row, allowed));
    const last = pageRows.at(-1);
    const lastItem = items.at(-1);
    const nextCursor = hasMore && last && lastItem
      ? signCursor({ v: 1, tenantHash: tenants, filterHash: filters, currency: lastItem.currency, amount: decimalString(last.estimatedMonthlySavingsAmount), id: lastItem.id }, this.cursorSigningKey)
      : null;
    return { items, nextCursor };
  }
}
