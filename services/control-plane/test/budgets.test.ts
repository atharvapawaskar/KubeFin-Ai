import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal128, type Collection, type Document } from 'mongodb';
import { MongoBudgetRepository, parseBudgetListQuery } from '../src/budgets.js';
import type { Principal } from '../src/auth.js';

const secret = '0123456789abcdef0123456789abcdef';
const input = { scope: { type: 'tenant' }, limitAmount: '100.00', currency: 'INR', period: 'daily' };
const principal: Principal = { subject: 'member', tenantIds: ['tenant-a'] };

class MemoryCollection {
  docs: Document[] = [];
  aggregates: Document[] = [];
  async createIndex(): Promise<string> { return 'index'; }
  find(filter: Document) {
    let docs = this.docs.filter((doc) => {
      if (filter.tenantId?.$in && !filter.tenantId.$in.includes(doc.tenantId)) return false;
      if (filter.currency?.$type === 'string' && typeof doc.currency !== 'string') return false;
      if (filter.$or) {
        const [tenantAfter, idAfter] = filter.$or as Document[];
        return doc.tenantId > tenantAfter!.tenantId.$gt
          || (doc.tenantId === idAfter!.tenantId && doc._id > idAfter!._id.$gt);
      }
      return true;
    });
    return {
      sort: () => {
        docs.sort((a, b) => String(a.tenantId).localeCompare(String(b.tenantId)) || String(a._id).localeCompare(String(b._id)));
        return { limit: (n: number) => ({ toArray: async () => docs.slice(0, n) }) };
      },
    };
  }
  async findOne(filter: Document): Promise<Document | null> {
    return this.docs.find((doc) => doc._id === filter._id && filter.tenantId.$in.includes(doc.tenantId)
      && (filter.currency?.$type !== 'string' || typeof doc.currency === 'string')) ?? null;
  }
  async insertOne(doc: Document): Promise<void> { this.docs.push(doc); }
  async findOneAndUpdate(filter: Document, update: Document): Promise<Document | null> {
    const doc = this.docs.find((entry) => entry._id === filter._id && entry.tenantId === filter.tenantId
      && (filter.currency?.$type !== 'string' || typeof entry.currency === 'string'));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return doc;
  }
  async deleteOne(filter: Document): Promise<{ deletedCount: number }> {
    const index = this.docs.findIndex((doc) => doc._id === filter._id && filter.tenantId.$in.includes(doc.tenantId)
      && (filter.currency?.$type !== 'string' || typeof doc.currency === 'string'));
    if (index < 0) return { deletedCount: 0 };
    this.docs.splice(index, 1);
    return { deletedCount: 1 };
  }
  aggregate(): { toArray: () => Promise<Document[]> } { return { toArray: async () => this.aggregates }; }
}

function repository(budgets = new MemoryCollection(), usage = new MemoryCollection()) {
  return {
    repo: new MongoBudgetRepository(
      budgets as unknown as Collection<{ _id: string; [key: string]: unknown }>,
      usage as unknown as Collection<Document>,
      secret,
    ),
    budgets,
    usage,
  };
}

test('budget inputs require positive exact amounts and bounded pagination', () => {
  assert.throws(() => parseBudgetListQuery({ pageSize: '101' }));
  assert.throws(() => parseBudgetListQuery({ unexpected: 'value' }));
  const { repo } = repository();
  assert.throws(() => new MongoBudgetRepository(
    new MemoryCollection() as unknown as Collection<{ _id: string; [key: string]: unknown }>,
    new MemoryCollection() as unknown as Collection<Document>,
    'short',
  ));
  return assert.rejects(repo.create(principal, { ...input, limitAmount: '0' }));
});

test('budget CRUD is tenant-scoped and list cursors paginate safely', async () => {
  const { repo, budgets } = repository();
  budgets.docs.push({ _id: 'bud_legacy', tenantId: 'tenant-a', scope: { type: 'tenant' }, limitUsd: 25, period: 'monthly' });
  const first = await repo.create(principal, input);
  const second = await repo.create(principal, { ...input, scope: { type: 'team', id: 'team-1' } });
  assert.equal(budgets.docs[0]?.tenantId, 'tenant-a');
  assert.equal(await repo.get(principal, 'bud_legacy').catch(() => null), null);
  assert.equal(await repo.get({ subject: 'member', tenantIds: ['tenant-b'] }, first.id), null);
  const page = await repo.list(principal, { pageSize: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items.some((item) => item.id === 'bud_legacy'), false);
  assert.ok(page.nextCursor);
  const next = await repo.list(principal, { pageSize: 1, cursor: page.nextCursor });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]?.id, page.items[0]?.id);
  await assert.rejects(repo.list({ subject: 'other', tenantIds: ['tenant-b'] }, { pageSize: 1, cursor: page.nextCursor }));
  await assert.rejects(repo.list(principal, { pageSize: 1, cursor: `${page.nextCursor}x` }));
  const updated = await repo.update(principal, second.id, { ...input, limitAmount: '125.00' });
  assert.equal(updated?.limitAmount, '125.00');
  assert.equal(await repo.delete({ subject: 'other', tenantIds: ['tenant-b'] }, first.id), false);
  assert.equal(await repo.delete(principal, first.id), true);
});

test('current spend uses exact decimal arithmetic and marks unpriced events unknown', async () => {
  const usage = new MemoryCollection();
  const now = new Date();
  usage.aggregates = [{
    _id: { tenantId: 'tenant-a', day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), pricingStatus: 'priced', currency: 'INR', teamId: null, workloadId: null },
    eventCount: 1,
    amount: Decimal128.fromString('80.125'),
  }];
  const { repo } = repository(new MemoryCollection(), usage);
  const budget = await repo.create(principal, { ...input, alertThresholdPct: 80 });
  assert.equal(budget.currentSpendAmount, '80.125');
  assert.equal(budget.spendStatus, 'warning');
  usage.aggregates.push({
    _id: { tenantId: 'tenant-a', day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), pricingStatus: 'unpriced', currency: null, teamId: null, workloadId: null },
    eventCount: 1,
    amount: Decimal128.fromString('0'),
  });
  const refreshed = await repo.get(principal, budget.id);
  assert.equal(refreshed?.unpricedEventCount, 1);
  assert.equal(refreshed?.spendStatus, 'unknown');
});
