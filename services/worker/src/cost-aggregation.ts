import { randomUUID } from 'node:crypto';
import { Decimal128, MongoServerError, type Collection, type Document } from 'mongodb';

export type AggregationGranularity = 'hour' | 'day';

export interface AggregationWindow {
  granularity: AggregationGranularity;
  windowStart: Date;
  windowEnd: Date;
}

export interface CostAggregationWindowState {
  _id: string;
  schemaVersion: 1;
  granularity: AggregationGranularity;
  windowStart: string;
  windowEnd: string;
  activeGeneration: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  leaseFence: number;
  updatedAt: string;
}

export interface CostAggregationDocumentId {
  granularity: AggregationGranularity;
  windowStart: string;
  tenantId: string;
  teamId: string | null;
  workloadId: string | null;
  provider: string;
  model: string;
  currency: string | null;
  pricingStatus: 'priced' | 'unpriced';
  generation: string;
}

export interface CostAggregationDocument {
  _id: CostAggregationDocumentId;
  schemaVersion: 1;
  granularity: AggregationGranularity;
  windowStart: string;
  windowEnd: string;
  tenantId: string;
  teamId: string | null;
  workloadId: string | null;
  provider: string;
  model: string;
  currency: string | null;
  pricingStatus: 'priced' | 'unpriced';
  eventCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costAmount?: Decimal128;
  generation: string;
  createdAt: string;
}

export interface CostAggregationFilter {
  tenantId?: string;
  teamId?: string;
  workloadId?: string;
  provider?: string;
  model?: string;
  currency?: string;
  pricingStatus?: 'priced' | 'unpriced';
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COARSE_CALENDAR_PADDING_MS = DAY_MS;
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;

export function makeAggregationWindows(
  from: Date,
  to: Date,
  granularity: AggregationGranularity,
  maximumWindows = granularity === 'hour' ? 744 : 366,
): AggregationWindow[] {
  const step = granularity === 'hour' ? HOUR_MS : DAY_MS;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from.getTime() >= to.getTime()) {
    throw new Error('Aggregation range must have valid dates with from earlier than to.');
  }
  if (from.getTime() % step !== 0 || to.getTime() % step !== 0) {
    throw new Error(`Aggregation range must align to UTC ${granularity} boundaries.`);
  }
  const count = (to.getTime() - from.getTime()) / step;
  if (!Number.isInteger(count) || count > maximumWindows) {
    throw new Error(`Aggregation range exceeds the ${maximumWindows} ${granularity} window limit.`);
  }
  return Array.from({ length: count }, (_, index) => {
    const windowStart = new Date(from.getTime() + index * step);
    return { granularity, windowStart, windowEnd: new Date(windowStart.getTime() + step) };
  });
}

export function aggregationWindowId(window: AggregationWindow): string {
  return `${window.granularity}:${window.windowStart.toISOString()}`;
}

function coarseOccurredAtFilter(window: AggregationWindow): Document {
  // Event timestamps retain their source offsets as ISO strings. Comparing a local
  // timestamp lexically with a UTC timestamp is incorrect near day boundaries. Use
  // an indexed calendar-date superset (offsets can shift a timestamp by at most a
  // day), then convert and apply the exact UTC half-open window in the pipeline.
  const from = new Date(window.windowStart.getTime() - COARSE_CALENDAR_PADDING_MS);
  const to = new Date(window.windowEnd.getTime() + COARSE_CALENDAR_PADDING_MS);
  return {
    occurredAt: {
      $gte: `${from.toISOString().slice(0, 10)}T00:00:00`,
      $lt: `${new Date(to.getTime() + DAY_MS).toISOString().slice(0, 10)}T00:00:00`,
    },
  };
}

function exactWindowStages(window: AggregationWindow): Document[] {
  return [
    { $match: coarseOccurredAtFilter(window) },
    {
      $set: {
        __aggregationOccurredAt: {
          $convert: { input: '$occurredAt', to: 'date', onError: null, onNull: null },
        },
      },
    },
    {
      $match: {
        __aggregationOccurredAt: { $gte: window.windowStart, $lt: window.windowEnd },
      },
    },
  ];
}

export function buildInvalidSourceEventsPipeline(window: AggregationWindow): Document[] {
  const invalidStatus = {
    $and: [
      { $ne: [{ $type: '$pricingStatus' }, 'missing'] },
      { $not: [{ $in: ['$pricingStatus', ['priced', 'unpriced']] }] },
    ],
  };
  const invalidTokenCount = (path: string): Document => ({
    $or: [
      { $not: [{ $isNumber: path }] },
      { $lt: [path, 0] },
      { $ne: [path, { $trunc: path }] },
    ],
  });
  const invalidRequiredString = (path: string): Document => ({
    $or: [
      { $ne: [{ $type: path }, 'string'] },
      { $eq: [path, ''] },
    ],
  });
  const invalidOptionalString = (path: string): Document => ({
    $and: [
      { $ne: [{ $type: path }, 'missing'] },
      {
        $or: [
          { $ne: [{ $type: path }, 'string'] },
          { $eq: [path, ''] },
        ],
      },
    ],
  });
  const invalidPricedCost = {
    $and: [
      { $eq: ['$pricingStatus', 'priced'] },
      {
        $or: [
          { $ne: [{ $type: '$costAmount' }, 'decimal'] },
          { $not: [{ $regexMatch: { input: { $ifNull: ['$costCurrency', ''] }, regex: '^[A-Z]{3}$' } }] },
          { $not: [{ $regexMatch: { input: { $ifNull: ['$pricingRecordId', ''] }, regex: '^.{1,128}$' } }] },
        ],
      },
    ],
  };
  const invalidUnpricedCost = {
    $and: [
      { $eq: ['$pricingStatus', 'unpriced'] },
      {
        $or: [
          { $ne: [{ $type: '$costAmount' }, 'missing'] },
          { $ne: [{ $type: '$costCurrency' }, 'missing'] },
          { $ne: [{ $type: '$pricingRecordId' }, 'missing'] },
        ],
      },
    ],
  };

  return [
    { $match: coarseOccurredAtFilter(window) },
    {
      $set: {
        __aggregationOccurredAt: {
          $convert: { input: '$occurredAt', to: 'date', onError: null, onNull: null },
        },
      },
    },
    {
      $match: {
        $or: [
          { __aggregationOccurredAt: null },
          { __aggregationOccurredAt: { $gte: window.windowStart, $lt: window.windowEnd } },
        ],
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            invalidStatus,
            invalidRequiredString('$tenantId'),
            invalidRequiredString('$provider'),
            invalidRequiredString('$model'),
            invalidOptionalString('$teamId'),
            invalidOptionalString('$workloadId'),
            { $eq: [{ $type: '$occurredAt' }, 'missing'] },
            { $eq: ['$__aggregationOccurredAt', null] },
            invalidTokenCount('$usage.inputTokens'),
            invalidTokenCount('$usage.outputTokens'),
            invalidPricedCost,
            invalidUnpricedCost,
          ],
        },
      },
    },
    { $count: 'invalidCount' },
  ];
}

export function buildCostAggregationPipeline(
  window: AggregationWindow,
  generation: string,
): Document[] {
  const pricingStatus = { $ifNull: ['$pricingStatus', 'unpriced'] };
  const bucketStart = {
    $dateToString: {
      date: {
        $dateTrunc: {
          date: '$__aggregationOccurredAt',
          unit: window.granularity,
          timezone: 'UTC',
        },
      },
      format: '%Y-%m-%dT%H:%M:%S.%LZ',
      timezone: 'UTC',
    },
  };

  return [
    ...exactWindowStages(window),
    {
      $group: {
        _id: {
          granularity: { $literal: window.granularity },
          windowStart: bucketStart,
          tenantId: '$tenantId',
          teamId: { $ifNull: ['$teamId', null] },
          workloadId: { $ifNull: ['$workloadId', null] },
          provider: '$provider',
          model: '$model',
          currency: { $cond: [{ $eq: [pricingStatus, 'priced'] }, '$costCurrency', null] },
          pricingStatus,
          generation: { $literal: generation },
        },
        eventCount: { $sum: 1 },
        totalInputTokens: { $sum: '$usage.inputTokens' },
        totalOutputTokens: { $sum: '$usage.outputTokens' },
        costAmount: {
          $sum: {
            $cond: [
              { $eq: [pricingStatus, 'priced'] },
              '$costAmount',
              Decimal128.fromString('0'),
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 1,
        schemaVersion: { $literal: 1 },
        granularity: '$_id.granularity',
        windowStart: '$_id.windowStart',
        windowEnd: {
          $dateToString: {
            date: {
              $dateAdd: {
                startDate: { $dateFromString: { dateString: '$_id.windowStart' } },
                unit: window.granularity,
                amount: 1,
                timezone: 'UTC',
              },
            },
            format: '%Y-%m-%dT%H:%M:%S.%LZ',
            timezone: 'UTC',
          },
        },
        tenantId: '$_id.tenantId',
        teamId: '$_id.teamId',
        workloadId: '$_id.workloadId',
        provider: '$_id.provider',
        model: '$_id.model',
        currency: '$_id.currency',
        pricingStatus: '$_id.pricingStatus',
        eventCount: 1,
        totalInputTokens: 1,
        totalOutputTokens: 1,
        costAmount: {
          $cond: [{ $eq: ['$_id.pricingStatus', 'priced'] }, '$costAmount', '$$REMOVE'],
        },
        generation: '$_id.generation',
        createdAt: {
          $dateToString: { date: '$$NOW', format: '%Y-%m-%dT%H:%M:%S.%LZ', timezone: 'UTC' },
        },
      },
    },
    {
      $merge: {
        into: 'cost_aggregations',
        on: '_id',
        whenMatched: 'replace',
        whenNotMatched: 'insert',
      },
    },
  ];
}

export class MongoCostAggregationStore {
  constructor(
    private readonly events: Collection,
    private readonly aggregations: Collection<CostAggregationDocument>,
    private readonly windows: Collection<CostAggregationWindowState>,
  ) {}

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.events.createIndex({ occurredAt: 1 }, { name: 'usage_events_occurred_at_asc' }),
      this.aggregations.createIndex(
        { granularity: 1, windowStart: 1, generation: 1, currency: 1, pricingStatus: 1 },
        { name: 'cost_aggregations_active_query_v1' },
      ),
      this.aggregations.createIndex(
        { createdAt: 1 },
        { name: 'cost_aggregations_generation_cleanup_v1' },
      ),
    ]);
  }

  async rebuildWindow(window: AggregationWindow): Promise<'published' | 'busy'> {
    const windowId = aggregationWindowId(window);
    const owner = randomUUID();
    const acquiredAt = new Date();
    const acquiredAtIso = acquiredAt.toISOString();
    let fence: number;

    try {
      const acquired = await this.windows.updateOne(
        {
          _id: windowId,
          $or: [
            { leaseExpiresAt: { $lte: acquiredAtIso } },
            { leaseExpiresAt: { $exists: false } },
          ],
        },
        {
          $setOnInsert: {
            _id: windowId,
            schemaVersion: 1,
            granularity: window.granularity,
            windowStart: window.windowStart.toISOString(),
            windowEnd: window.windowEnd.toISOString(),
            activeGeneration: null,
          },
          $set: {
            leaseOwner: owner,
            leaseExpiresAt: new Date(acquiredAt.getTime() + LEASE_MS).toISOString(),
            updatedAt: acquiredAtIso,
          },
          $inc: { leaseFence: 1 },
        },
        { upsert: true },
      );
      if (acquired.matchedCount !== 1 && acquired.upsertedCount !== 1) return 'busy';
      const state = await this.windows.findOne({ _id: windowId, leaseOwner: owner });
      if (!state) throw new Error('Aggregation window lease was not visible after acquisition.');
      fence = state.leaseFence;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return 'busy';
      throw error;
    }

    const generation = randomUUID();
    let published = false;
    let leaseLost = false;
    const renew = async (): Promise<void> => {
      const now = new Date();
      const result = await this.windows.updateOne(
        { _id: windowId, leaseOwner: owner, leaseFence: fence, leaseExpiresAt: { $gt: now.toISOString() } },
        { $set: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(), updatedAt: now.toISOString() } },
      );
      if (result.matchedCount !== 1) leaseLost = true;
    };
    const heartbeat = setInterval(() => {
      void renew().catch(() => { leaseLost = true; });
    }, RENEW_MS);
    heartbeat.unref();

    try {
      const invalid = await this.events.aggregate<{ invalidCount: number }>(
        buildInvalidSourceEventsPipeline(window),
        { allowDiskUse: true },
      ).next();
      if (invalid && invalid.invalidCount > 0) {
        throw new Error(`Refusing to aggregate ${invalid.invalidCount} invalid source event(s) in ${windowId}.`);
      }

      await this.events.aggregate(
        buildCostAggregationPipeline(window, generation),
        { allowDiskUse: true, comment: `stage4-rollup:${windowId}:${generation}` },
      ).toArray();

      await renew();
      if (leaseLost) throw new Error(`Lost aggregation window lease before publishing ${windowId}.`);
      const publishAt = new Date().toISOString();
      const result = await this.windows.updateOne(
        { _id: windowId, leaseOwner: owner, leaseFence: fence, leaseExpiresAt: { $gt: publishAt } },
        {
          $set: { activeGeneration: generation, updatedAt: publishAt },
          $unset: { leaseOwner: '', leaseExpiresAt: '' },
        },
      );
      if (result.matchedCount !== 1) throw new Error(`Lost aggregation window lease while publishing ${windowId}.`);
      published = true;
      return 'published';
    } finally {
      clearInterval(heartbeat);
      if (!published) {
        await this.aggregations.deleteMany({ '_id.generation': generation }).catch(() => undefined);
        await this.windows.updateOne(
          { _id: windowId, leaseOwner: owner, leaseFence: fence },
          { $set: { leaseOwner: null, leaseExpiresAt: new Date(0).toISOString(), updatedAt: new Date().toISOString() } },
        ).catch(() => undefined);
      }
    }
  }

  async queryActiveWindow(
    window: AggregationWindow,
    filter: CostAggregationFilter = {},
  ): Promise<CostAggregationDocument[]> {
    const state = await this.windows.findOne({ _id: aggregationWindowId(window) });
    if (!state?.activeGeneration) return [];
    const query: Document = {
      granularity: window.granularity,
      windowStart: window.windowStart.toISOString(),
      generation: state.activeGeneration,
      ...filter,
    };
    return this.aggregations.find(query).sort({ tenantId: 1, provider: 1, model: 1, currency: 1 }).toArray();
  }

  async queryActiveRange(
    from: Date,
    to: Date,
    granularity: AggregationGranularity,
    filter: CostAggregationFilter = {},
  ): Promise<CostAggregationDocument[]> {
    const windows = makeAggregationWindows(from, to, granularity);
    const states = await this.windows.find({
      _id: { $in: windows.map(aggregationWindowId) },
      activeGeneration: { $type: 'string' },
    }).toArray();
    if (states.length === 0) return [];
    const query: Document = {
      granularity,
      $or: states.map((state) => ({
        windowStart: state.windowStart,
        generation: state.activeGeneration,
      })),
      ...filter,
    };
    return this.aggregations.find(query)
      .sort({ windowStart: 1, tenantId: 1, provider: 1, model: 1, currency: 1, pricingStatus: 1 })
      .toArray();
  }

  async pruneSupersededGenerations(
    windows: AggregationWindow[],
    olderThan: Date,
  ): Promise<number> {
    if (!Number.isFinite(olderThan.getTime()) || olderThan.getTime() > Date.now()) {
      throw new Error('Generation cleanup cutoff must be a valid timestamp in the past.');
    }
    let deleted = 0;
    for (const window of windows) {
      const state = await this.windows.findOne({ _id: aggregationWindowId(window) });
      const query: Document = {
        granularity: window.granularity,
        windowStart: window.windowStart.toISOString(),
        createdAt: { $lt: olderThan.toISOString() },
        ...(state?.activeGeneration ? { '_id.generation': { $ne: state.activeGeneration } } : {}),
      };
      const result = await this.aggregations.deleteMany(query);
      deleted += result.deletedCount;
    }
    return deleted;
  }
}
