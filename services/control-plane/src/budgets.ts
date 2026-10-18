import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { z } from 'zod';
import type { Principal } from './auth.js';

const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const scopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tenant') }).strict(),
  z.object({ type: z.literal('team'), id: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('workload'), id: z.string().min(1).max(256) }).strict(),
]);
const budgetInputSchema = z.object({
  scope: scopeSchema,
  limitAmount: z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/),
  currency: currencySchema,
  period: z.enum(['daily', 'monthly']),
  alertThresholdPct: z.number().int().min(1).max(100).default(80),
  enforcement: z.enum(['hard', 'alert_only']).default('hard'),
}).strict().superRefine((value, context) => {
  if (!/[1-9]/.test(value.limitAmount)) context.addIssue({ code: 'custom', path: ['limitAmount'], message: 'limitAmount must be greater than zero.' });
});
const listQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
const budgetIdSchema = z.string().regex(/^bud_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const ZERO = Decimal128.fromString('0');

export type BudgetScope = z.infer<typeof scopeSchema>;
export interface BudgetInput {
  scope: BudgetScope;
  limitAmount: string;
  currency: string;
  period: 'daily' | 'monthly';
  alertThresholdPct: number;
  enforcement: 'hard' | 'alert_only';
}
export interface Budget extends BudgetInput {
  id: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  currentSpendAmount: string;
  unpricedEventCount: number;
  spendStatus: 'ok' | 'warning' | 'exceeded' | 'unknown';
  spendAsOf: string;
}
export interface BudgetPage { items: Budget[]; nextCursor: string | null }
export interface BudgetListQuery { pageSize: number; cursor?: string }
export class InvalidBudgetError extends Error {}
export class DuplicateBudgetError extends Error {}
export class InvalidBudgetCursorError extends Error {}
export class InvalidBudgetDataError extends Error {}

interface StoredBudget extends Document { _id: string }
interface BudgetCursor { v: 1; tenantId: string; id: string; tenantHash: string }

export function parseBudgetId(value: unknown): string {
  const parsed = budgetIdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidBudgetError('budgetId is invalid.');
  return parsed.data;
}

export function parseBudgetListQuery(raw: unknown): BudgetListQuery {
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success) throw new InvalidBudgetError('Invalid budget list query.');
  return { pageSize: parsed.data.pageSize, ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}) };
}

function parseInput(raw: unknown): BudgetInput {
  const parsed = budgetInputSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidBudgetError(`Invalid budget input: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'body').join(', ')}.`);
  return parsed.data;
}

function fromDocument(doc: Document): Budget {
  const id = parseBudgetId(doc._id);
  const tenant = z.string().min(1).max(256).safeParse(doc.tenantId);
  const threshold = z.number().int().min(1).max(100).safeParse(doc.alertThresholdPct);
  const enforcement = z.enum(['hard', 'alert_only']).safeParse(doc.enforcement);
  if (!tenant.success || !threshold.success || !enforcement.success || typeof doc.limitAmount !== 'string') {
    throw new InvalidBudgetDataError('Stored budget fields are invalid.');
  }
  const validTimestamp = (value: unknown): Date => {
    if (value instanceof Date) return value;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      return new Date(Number.NaN);
    }
    return new Date(value);
  };
  const createdAt = validTimestamp(doc.createdAt);
  const updatedAt = validTimestamp(doc.updatedAt);
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(updatedAt.getTime())) throw new InvalidBudgetDataError('Stored budget timestamps are invalid.');
  const input = parseInput({
    scope: doc.scope,
    limitAmount: doc.limitAmount,
    currency: doc.currency,
    period: doc.period,
    alertThresholdPct: doc.alertThresholdPct,
    enforcement: doc.enforcement,
  });
  return {
    id,
    tenantId: tenant.data,
    ...input,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    currentSpendAmount: '0',
    unpricedEventCount: 0,
    spendStatus: 'ok',
    spendAsOf: updatedAt.toISOString(),
  };
}

function decimalUnits(value: unknown): bigint {
  const raw = value instanceof Decimal128 ? value.toString() : String(value ?? '0');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) throw new InvalidBudgetDataError('Stored budget or usage amount is not a valid decimal.');
  let digits = `${match[2]}${match[3] ?? ''}`;
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (!/[1-9]/.test(digits)) return 0n;
  if (scale < 0) {
    if (digits.length - scale > 18) throw new InvalidBudgetDataError('Stored amount exceeds the supported integer range.');
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  if (scale > SCALE) throw new InvalidBudgetDataError('Stored amount exceeds the supported decimal precision.');
  if (Math.max(1, digits.length - scale) > 18) throw new InvalidBudgetDataError('Stored amount exceeds the supported integer range.');
  if (match[1] === '-' && /[1-9]/.test(digits)) throw new InvalidBudgetDataError('Negative amounts are invalid for budgets.');
  return BigInt(digits) * 10n ** BigInt(SCALE - scale);
}

function decimalString(units: bigint): string {
  if (units < 0n) throw new InvalidBudgetDataError('Negative spend is invalid.');
  const integer = (units / SCALE_FACTOR).toString();
  if (integer.length > 18) throw new InvalidBudgetDataError('Spend exceeds the supported integer range.');
  const fraction = (units % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function utcMonthStart(now: Date): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); }
function utcDayStart(now: Date): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); }

function tenantHash(tenantIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...new Set(tenantIds)].sort())).digest('base64url');
}

function signCursor(payload: BudgetCursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function verifyCursor(value: string, secret: string, expectedTenantHash: string): BudgetCursor {
  if (value.length > 2048) throw new InvalidBudgetCursorError('Invalid budget cursor.');
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) throw new InvalidBudgetCursorError('Invalid budget cursor.');
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new InvalidBudgetCursorError('Invalid budget cursor.');
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<BudgetCursor>;
    if (payload.v !== 1 || typeof payload.tenantId !== 'string' || typeof payload.id !== 'string'
      || payload.tenantHash !== expectedTenantHash || !budgetIdSchema.safeParse(payload.id).success) {
      throw new InvalidBudgetCursorError('Invalid budget cursor.');
    }
    return payload as BudgetCursor;
  } catch (error) {
    if (error instanceof InvalidBudgetCursorError) throw error;
    throw new InvalidBudgetCursorError('Invalid budget cursor.');
  }
}

function belongsToScope(budget: Budget, row: Document): boolean {
  const id = row._id as Document;
  if (id.tenantId !== budget.tenantId) return false;
  if (budget.scope.type === 'team') return id.teamId === budget.scope.id;
  if (budget.scope.type === 'workload') return id.workloadId === budget.scope.id;
  return true;
}

function applySpend(budgets: Budget[], rows: Document[], now: Date): void {
  const dayStart = utcDayStart(now);
  const monthStart = utcMonthStart(now);
  for (const budget of budgets) {
    let amountUnits = 0n;
    let unpricedCount = 0;
    const start = budget.period === 'daily' ? dayStart : monthStart;
    for (const row of rows) {
      const id = row._id as Document;
      const bucket = id.day as Date;
      if (!belongsToScope(budget, row) || !(bucket instanceof Date) || bucket < start || bucket >= now) continue;
      if (id.pricingStatus === 'unpriced' || id.pricingStatus === 'unknown') {
        const count = Number(row.eventCount ?? 0);
        if (!Number.isSafeInteger(count) || count < 0) throw new InvalidBudgetDataError('Usage event count is invalid.');
        unpricedCount += count;
        if (!Number.isSafeInteger(unpricedCount)) throw new InvalidBudgetDataError('Unpriced usage count exceeds the safe integer range.');
      } else if (id.pricingStatus === 'priced' && id.currency === budget.currency) {
        amountUnits += decimalUnits(row.amount);
      }
    }
    const limitUnits = decimalUnits(budget.limitAmount);
    budget.currentSpendAmount = decimalString(amountUnits);
    budget.unpricedEventCount = unpricedCount;
    budget.spendAsOf = now.toISOString();
    if (unpricedCount > 0) budget.spendStatus = 'unknown';
    else if (amountUnits >= limitUnits) budget.spendStatus = 'exceeded';
    else if (amountUnits * 100n >= limitUnits * BigInt(budget.alertThresholdPct)) budget.spendStatus = 'warning';
    else budget.spendStatus = 'ok';
  }
}

export class MongoBudgetRepository {
  constructor(
    private readonly collection: Collection<StoredBudget>,
    private readonly usageEvents: Collection<Document>,
    private readonly cursorSigningKey: string,
  ) {
    if (Buffer.byteLength(cursorSigningKey) < 32) throw new Error('Budget cursor signing key must be at least 32 bytes.');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { tenantId: 1, 'scope.type': 1, 'scope.id': 1, currency: 1, period: 1 },
      { unique: true, name: 'budget_scope_currency_period_unique', partialFilterExpression: { currency: { $type: 'string' } } },
    );
    await this.usageEvents.createIndex({ tenantId: 1, occurredAt: 1 }, { name: 'budget_spend_tenant_period' });
  }

  async list(principal: Principal, rawQuery: unknown): Promise<BudgetPage> {
    const query = parseBudgetListQuery(rawQuery);
    const tenantIds = [...new Set(principal.tenantIds)].sort();
    if (!tenantIds.length) return { items: [], nextCursor: null };
    const hash = tenantHash(tenantIds);
    const cursor = query.cursor ? verifyCursor(query.cursor, this.cursorSigningKey, hash) : undefined;
    const filter: Document = { tenantId: { $in: tenantIds }, currency: { $type: 'string' } };
    if (cursor) filter.$or = [
      { tenantId: { $gt: cursor.tenantId } },
      { tenantId: cursor.tenantId, _id: { $gt: cursor.id } },
    ];
    const docs = await this.collection.find(filter)
      .sort({ tenantId: 1, _id: 1 })
      .limit(query.pageSize + 1)
      .toArray();
    const hasMore = docs.length > query.pageSize;
    const selected = hasMore ? docs.slice(0, query.pageSize) : docs;
    const budgets = selected.map(fromDocument);
    await this.attachCurrentSpend(budgets, tenantIds, new Date());
    const last = selected.at(-1);
    return {
      items: budgets,
      nextCursor: hasMore && last ? signCursor({ v: 1, tenantId: last.tenantId, id: last._id, tenantHash: hash }, this.cursorSigningKey) : null,
    };
  }

  async get(principal: Principal, id: string): Promise<Budget | null> {
    const validId = parseBudgetId(id);
    const tenantIds = [...new Set(principal.tenantIds)];
    if (!tenantIds.length) return null;
    const doc = await this.collection.findOne({ _id: validId, tenantId: { $in: tenantIds }, currency: { $type: 'string' } });
    if (!doc) return null;
    const budget = fromDocument(doc);
    await this.attachCurrentSpend([budget], tenantIds, new Date());
    return budget;
  }

  async create(principal: Principal, raw: unknown): Promise<Budget> {
    const input = parseInput(raw);
    const tenantIds = [...new Set(principal.tenantIds)];
    if (tenantIds.length !== 1) throw new InvalidBudgetError('Creating a budget requires a token scoped to exactly one tenant.');
    const now = new Date().toISOString();
    const doc = { _id: `bud_${randomUUID()}`, tenantId: tenantIds[0]!, ...input, createdAt: now, updatedAt: now };
    try { await this.collection.insertOne(doc); }
    catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateBudgetError('A budget already exists for this scope, currency, and period.');
      throw error;
    }
    const budget = fromDocument(doc);
    await this.attachCurrentSpend([budget], tenantIds, new Date());
    return budget;
  }

  async update(principal: Principal, id: string, raw: unknown): Promise<Budget | null> {
    const input = parseInput(raw);
    const validId = parseBudgetId(id);
    const tenantIds = [...new Set(principal.tenantIds)];
    if (!tenantIds.length) return null;
    const current = await this.collection.findOne({ _id: validId, tenantId: { $in: tenantIds }, currency: { $type: 'string' } });
    if (!current) return null;
    try {
      const result = await this.collection.findOneAndUpdate(
        { _id: validId, tenantId: current.tenantId, currency: { $type: 'string' } },
        { $set: { ...input, updatedAt: new Date().toISOString() } },
        { returnDocument: 'after' },
      );
      if (!result) return null;
      const budget = fromDocument(result);
      await this.attachCurrentSpend([budget], tenantIds, new Date());
      return budget;
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateBudgetError('A budget already exists for this scope, currency, and period.');
      throw error;
    }
  }

  async delete(principal: Principal, id: string): Promise<boolean> {
    const validId = parseBudgetId(id);
    const tenantIds = [...new Set(principal.tenantIds)];
    if (!tenantIds.length) return false;
    const result = await this.collection.deleteOne({ _id: validId, tenantId: { $in: tenantIds }, currency: { $type: 'string' } });
    return result.deletedCount === 1;
  }

  private async attachCurrentSpend(budgets: Budget[], tenantIds: readonly string[], now: Date): Promise<void> {
    if (!budgets.length) return;
    const monthStart = utcMonthStart(now);
    const coarseStart = new Date(monthStart.getTime() - 14 * 60 * 60 * 1000).toISOString();
    const coarseEnd = new Date(now.getTime() + 14 * 60 * 60 * 1000).toISOString();
    const rows = await this.usageEvents.aggregate([
      { $match: { tenantId: { $in: [...tenantIds] }, occurredAt: { $gte: coarseStart, $lt: coarseEnd } } },
      { $set: {
        __budgetOccurredAt: { $dateFromString: { dateString: '$occurredAt', onError: null, onNull: null } },
        __budgetCurrencyValid: { $cond: [
          { $eq: [{ $type: '$costCurrency' }, 'string'] },
          { $regexMatch: { input: '$costCurrency', regex: '^[A-Z]{3}$' } },
          false,
        ] },
      } },
      { $match: { $expr: { $and: [
        { $ne: ['$__budgetOccurredAt', null] },
        { $gte: ['$__budgetOccurredAt', monthStart] },
        { $lt: ['$__budgetOccurredAt', now] },
      ] } } },
      { $set: {
        __budgetStatus: { $switch: {
          branches: [
            { case: { $and: [
              { $eq: ['$pricingStatus', 'priced'] },
              { $isNumber: '$costAmount' },
              { $gte: ['$costAmount', ZERO] },
              '$__budgetCurrencyValid',
            ] }, then: 'priced' },
            { case: { $eq: ['$pricingStatus', 'unpriced'] }, then: 'unpriced' },
          ],
          default: 'unknown',
        } },
        __budgetDay: { $dateTrunc: { date: '$__budgetOccurredAt', unit: 'day', timezone: 'UTC' } },
      } },
      { $group: {
        _id: {
          tenantId: '$tenantId',
          teamId: { $ifNull: ['$teamId', null] },
          workloadId: { $ifNull: ['$workloadId', null] },
          day: '$__budgetDay',
          pricingStatus: '$__budgetStatus',
          currency: { $cond: [{ $eq: ['$__budgetStatus', 'priced'] }, '$costCurrency', null] },
        },
        eventCount: { $sum: 1 },
        amount: { $sum: { $cond: [
          { $eq: ['$__budgetStatus', 'priced'] }, '$costAmount', ZERO,
        ] } },
      } },
    ]).toArray();
    applySpend(budgets, rows, now);
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 11000;
}
