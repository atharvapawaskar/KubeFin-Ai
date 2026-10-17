import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { z } from 'zod';

export type Granularity = 'hour' | 'day';
export type GroupBy = 'tenant' | 'team' | 'workload' | 'provider' | 'model';
export type PricingStatus = 'priced' | 'unpriced';

export interface AnalyticsQuery {
  from: Date;
  to: Date;
  granularity: Granularity;
  groupBy?: GroupBy;
  tenantId?: string;
  teamId?: string;
  workloadId?: string;
  provider?: string;
  model?: string;
  currency?: string;
  pricingStatus?: PricingStatus;
  pageSize: number;
  cursor?: string;
}

const querySchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  granularity: z.enum(['hour', 'day']).default('day'),
  groupBy: z.enum(['tenant', 'team', 'workload', 'provider', 'model']).optional(),
  tenantId: z.string().min(1).max(256).optional(),
  teamId: z.string().min(1).max(256).optional(),
  workloadId: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(256).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  pricingStatus: z.enum(['priced', 'unpriced']).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_WINDOWS = { hour: 744, day: 366 } as const;

export class InvalidAnalyticsQueryError extends Error {
  constructor(readonly code: 'INVALID_RANGE' | 'INVALID_FILTER', message: string) {
    super(message);
  }
}

export class InvalidAnalyticsResultError extends Error {}

function parseTimestamp(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${name} must be an RFC 3339 timestamp with an explicit timezone.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid.`);
  return date;
}

export function parseAnalyticsQuery(raw: unknown): AnalyticsQuery {
  const result = querySchema.safeParse(raw);
  if (!result.success) {
    const rangeIssue = result.error.issues.some((issue) => issue.path[0] === 'from' || issue.path[0] === 'to');
    throw new InvalidAnalyticsQueryError(rangeIssue ? 'INVALID_RANGE' : 'INVALID_FILTER', `Invalid analytics query: ${result.error.issues.map((issue) => issue.path.join('.') || 'query').join(', ')}.`);
  }
  const value = result.data;
  let from: Date;
  let to: Date;
  try {
    from = parseTimestamp(value.from, 'from');
    to = parseTimestamp(value.to, 'to');
  } catch (error) {
    throw new InvalidAnalyticsQueryError('INVALID_RANGE', error instanceof Error ? error.message : 'Invalid time range.');
  }
  const step = value.granularity === 'hour' ? HOUR_MS : DAY_MS;
  if (from.getTime() >= to.getTime()) throw new InvalidAnalyticsQueryError('INVALID_RANGE', 'from must be earlier than to.');
  if (from.getTime() % step !== 0 || to.getTime() % step !== 0) throw new InvalidAnalyticsQueryError('INVALID_RANGE', `from and to must align to UTC ${value.granularity} boundaries.`);
  const windows = (to.getTime() - from.getTime()) / step;
  if (!Number.isInteger(windows) || windows > MAX_WINDOWS[value.granularity]) throw new InvalidAnalyticsQueryError('INVALID_RANGE', `Range exceeds ${MAX_WINDOWS[value.granularity]} ${value.granularity} windows.`);
  if (value.cursor && !value.groupBy) throw new InvalidAnalyticsQueryError('INVALID_FILTER', 'cursor requires groupBy.');
  return {
    from,
    to,
    granularity: value.granularity,
    ...(value.groupBy ? { groupBy: value.groupBy } : {}),
    ...(value.tenantId ? { tenantId: value.tenantId } : {}),
    ...(value.teamId ? { teamId: value.teamId } : {}),
    ...(value.workloadId ? { workloadId: value.workloadId } : {}),
    ...(value.provider ? { provider: value.provider } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.currency ? { currency: value.currency } : {}),
    ...(value.pricingStatus ? { pricingStatus: value.pricingStatus } : {}),
    pageSize: value.pageSize,
    ...(value.cursor ? { cursor: value.cursor } : {}),
  };
}

interface CursorPayload {
  v: 1;
  queryHash: string;
  amount: string;
  currency: string | null;
  status: PricingStatus;
  key: string | null;
}

function cursorQueryHash(query: AnalyticsQuery, tenantIds: readonly string[], generations: readonly string[]): string {
  const stable = {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    granularity: query.granularity,
    groupBy: query.groupBy,
    tenantId: query.tenantId,
    teamId: query.teamId,
    workloadId: query.workloadId,
    provider: query.provider,
    model: query.model,
    currency: query.currency,
    pricingStatus: query.pricingStatus,
    tenantIds: [...tenantIds].sort(),
    generations: [...generations].sort(),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('base64url');
}

function signCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyCursor(token: string, secret: string, expectedHash: string): CursorPayload {
  if (token.length > 2048) throw new Error('Invalid cursor.');
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) throw new Error('Invalid cursor.');
  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try { provided = Buffer.from(signature, 'base64url'); } catch { throw new Error('Invalid cursor.'); }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error('Invalid cursor.');
  let payload: CursorPayload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload; } catch { throw new Error('Invalid cursor.'); }
  if (payload.v !== 1 || payload.queryHash !== expectedHash || typeof payload.amount !== 'string'
      || !(payload.currency === null || (typeof payload.currency === 'string' && /^[A-Z]{3}$/.test(payload.currency)))
      || (payload.status !== 'priced' && payload.status !== 'unpriced')
      || !(payload.key === null || typeof payload.key === 'string')) throw new Error('Cursor does not match this query.');
  return payload;
}

function decimalString(value: unknown): string {
  if (value === undefined || value === null) return '0';
  const raw = value instanceof Decimal128 ? value.toString() : String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) throw new InvalidAnalyticsResultError('MongoDB returned an invalid decimal amount.');
  const negative = match[1] === '-';
  let digits = `${match[2]}${match[3] ?? ''}`;
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  if (digits.length <= scale) digits = `${'0'.repeat(scale - digits.length + 1)}${digits}`;
  const split = digits.length - scale;
  const integer = digits.slice(0, split).replace(/^0+(?=\d)/, '');
  const fraction = scale ? digits.slice(split).replace(/0+$/, '') : '';
  const result = fraction ? `${integer}.${fraction}` : integer;
  if (negative && result !== '0') throw new InvalidAnalyticsResultError('MongoDB returned a negative cost amount.');
  return result;
}

function countNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(String(value ?? 0));
  if (!Number.isSafeInteger(number) || number < 0) throw new InvalidAnalyticsResultError('Aggregated count exceeds the API safe integer range.');
  return number;
}

function toMoney(row: Document, includeBucket = false, includeKey = false): Document {
  const status = row.pricingStatus as PricingStatus;
  if (status !== 'priced' && status !== 'unpriced') throw new InvalidAnalyticsResultError('MongoDB returned an invalid pricing status.');
  if (status === 'priced' && (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency))) {
    throw new InvalidAnalyticsResultError('MongoDB returned an invalid priced currency.');
  }
  if (status === 'unpriced' && row.currency !== null) throw new InvalidAnalyticsResultError('MongoDB returned a currency for unpriced usage.');
  if (includeKey && row.key !== null && (typeof row.key !== 'string' || row.key.length > 256)) {
    throw new InvalidAnalyticsResultError('MongoDB returned an invalid breakdown key.');
  }
  const result: Document = {
    ...(includeBucket ? { bucketStart: row.bucketStart } : {}),
    ...(includeKey ? { key: row.key ?? null } : {}),
    currency: status === 'priced' ? row.currency : null,
    pricingStatus: status,
    requests: countNumber(row.requests),
    inputTokens: countNumber(row.inputTokens),
    outputTokens: countNumber(row.outputTokens),
  };
  if (status === 'priced') result.costAmount = decimalString(row.costAmount);
  return result;
}

function sourceFilter(query: AnalyticsQuery, allowedTenantIds: readonly string[]): Document {
  const filter: Document = {
    granularity: query.granularity,
    $or: [] as Document[],
    tenantId: { $in: [...allowedTenantIds] },
  };
  for (const [key, value] of Object.entries({
    tenantId: query.tenantId,
    teamId: query.teamId,
    workloadId: query.workloadId,
    provider: query.provider,
    model: query.model,
    currency: query.currency,
    pricingStatus: query.pricingStatus,
  })) if (value !== undefined) filter[key] = value;
  return filter;
}

function aggregateGroup(id: Document): Document[] {
  return [
    { $group: {
      _id: id,
      requests: { $sum: '$eventCount' },
      inputTokens: { $sum: '$totalInputTokens' },
      outputTokens: { $sum: '$totalOutputTokens' },
      costAmount: { $sum: { $cond: [{ $eq: ['$pricingStatus', 'priced'] }, '$costAmount', Decimal128.fromString('0')] } },
    } },
    { $project: {
      _id: 0,
      bucketStart: '$_id.bucketStart',
      key: '$_id.key',
      currency: '$_id.currency',
      pricingStatus: '$_id.pricingStatus',
      requests: 1,
      inputTokens: 1,
      outputTokens: 1,
      costAmount: 1,
    } },
  ];
}

export interface AnalyticsRepositoryOptions {
  aggregations: Collection<{ _id: Document; [key: string]: unknown }>;
  windows: Collection<{ _id: string; windowStart: string; activeGeneration: string | null; [key: string]: unknown }>;
  cursorSigningKey: string;
}

export class MongoAnalyticsRepository {
  constructor(private readonly options: AnalyticsRepositoryOptions) {}

  async ensureIndexes(): Promise<void> {
    await this.options.aggregations.createIndex(
      { granularity: 1, windowStart: 1, generation: 1, tenantId: 1, currency: 1, pricingStatus: 1 },
      { name: 'cost_aggregations_control_plane_query_v1' },
    );
  }

  async spend(query: AnalyticsQuery, allowedTenantIds: readonly string[]): Promise<Document> {
    const allowed = [...new Set(allowedTenantIds)].sort();
    if (allowed.length === 0) throw new Error('Principal has no authorized tenant scope.');
    if (query.tenantId && !allowed.includes(query.tenantId)) throw Object.assign(new Error('Tenant is outside the authenticated scope.'), { statusCode: 403 });
    const step = query.granularity === 'hour' ? HOUR_MS : DAY_MS;
    const stateIds: string[] = [];
    for (let time = query.from.getTime(); time < query.to.getTime(); time += step) {
      stateIds.push(`${query.granularity}:${new Date(time).toISOString()}`);
    }
    const activeStates = await this.options.windows.find({
      _id: { $in: stateIds },
      activeGeneration: { $type: 'string' },
    }, { projection: { windowStart: 1, activeGeneration: 1 } }).toArray();
    const response: Document = {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      granularity: query.granularity,
      totals: [],
      series: [],
      breakdown: { items: [], nextCursor: null },
    };
    if (activeStates.length !== stateIds.length) throw new Error('Rollup snapshots are not published for the complete requested range.');
    const activeGenerationIds = activeStates.map((state) => String(state.activeGeneration));
    const base = sourceFilter(query, allowed);
    base.$or = activeStates.map((state) => ({ windowStart: state.windowStart, generation: state.activeGeneration }));
    const zero = Decimal128.fromString('0');
    const totalsPipeline = [
      { $match: base },
      ...aggregateGroup({ currency: '$currency', pricingStatus: '$pricingStatus' }),
      { $sort: { currency: 1, pricingStatus: 1 } },
    ];
    const seriesPipeline = [
      { $match: base },
      ...aggregateGroup({ bucketStart: '$windowStart', currency: '$currency', pricingStatus: '$pricingStatus' }),
      { $sort: { bucketStart: 1, currency: 1, pricingStatus: 1 } },
    ];
    const [totals, series] = await Promise.all([
      this.options.aggregations.aggregate(totalsPipeline, { allowDiskUse: true }).toArray(),
      this.options.aggregations.aggregate(seriesPipeline, { allowDiskUse: true }).toArray(),
    ]);
    response.totals = totals.map((row) => toMoney(row));
    response.series = series.map((row) => toMoney(row, true));

    const currentStates = await this.options.windows.find({ _id: { $in: stateIds } }, { projection: { _id: 1, activeGeneration: 1 } }).toArray();
    const currentGenerations = new Map(currentStates.map((state) => [state._id, state.activeGeneration]));
    if (activeStates.some((state) => currentGenerations.get(state._id) !== state.activeGeneration)) {
      throw new Error('Rollup generations changed while reading; retry the analytics query.');
    }

    if (!query.groupBy) return response;
    const dimension: Record<GroupBy, string> = {
      tenant: 'tenantId', team: 'teamId', workload: 'workloadId', provider: 'provider', model: 'model',
    };
    const keyField = dimension[query.groupBy];
    const matchStages: Document[] = [];
    const queryHash = cursorQueryHash(query, allowed, activeGenerationIds);
    let cursor: CursorPayload | undefined;
    if (query.cursor) {
      cursor = verifyCursor(query.cursor, this.options.cursorSigningKey, queryHash);
      const amount = Decimal128.fromString(cursor.amount);
      matchStages.push({ $match: { $or: [
        { __sortAmount: { $lt: amount } },
        { __sortAmount: amount, currency: { $gt: cursor.currency } },
        { __sortAmount: amount, currency: cursor.currency, pricingStatus: { $gt: cursor.status } },
        { __sortAmount: amount, currency: cursor.currency, pricingStatus: cursor.status, key: { $gt: cursor.key } },
      ] } });
    }
    const breakdownPipeline: Document[] = [
      { $match: base },
      { $set: { key: { $ifNull: [`$${keyField}`, null] } } },
      ...aggregateGroup({ key: '$key', currency: '$currency', pricingStatus: '$pricingStatus' }),
      { $set: { __sortAmount: { $ifNull: ['$costAmount', zero] } } },
      ...matchStages,
      { $sort: { __sortAmount: -1, currency: 1, pricingStatus: 1, key: 1 } },
      { $limit: query.pageSize + 1 },
    ];
    const page = await this.options.aggregations.aggregate(breakdownPipeline, { allowDiskUse: true }).toArray();
    const afterBreakdownStates = await this.options.windows.find({ _id: { $in: stateIds } }, { projection: { _id: 1, activeGeneration: 1 } }).toArray();
    const afterBreakdownGenerations = new Map(afterBreakdownStates.map((state) => [state._id, state.activeGeneration]));
    if (activeStates.some((state) => afterBreakdownGenerations.get(state._id) !== state.activeGeneration)) {
      throw new Error('Rollup generations changed while reading; retry the analytics query.');
    }
    const hasMore = page.length > query.pageSize;
    const selected = hasMore ? page.slice(0, query.pageSize) : page;
    response.breakdown = {
      items: selected.map((row) => toMoney(row, false, true)),
      nextCursor: hasMore ? signCursor({
        v: 1,
        queryHash,
        amount: decimalString(selected.at(-1)?.costAmount),
        currency: selected.at(-1)?.pricingStatus === 'priced' ? String(selected.at(-1)?.currency) : null,
        status: selected.at(-1)?.pricingStatus as PricingStatus,
        key: selected.at(-1)?.key === undefined || selected.at(-1)?.key === null ? null : String(selected.at(-1)?.key),
      }, this.options.cursorSigningKey) : null,
    };
    return response;
  }
}
