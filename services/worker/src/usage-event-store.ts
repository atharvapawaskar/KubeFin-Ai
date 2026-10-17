import { MongoServerError, type Collection, type Filter } from 'mongodb';
import { calculateCostUsd } from './cost-engine.js';
import type { PricingCatalog } from './pricing-catalog.js';
import type { UsageEvent } from './usage-event.js';
import { toUsageEventDocument, type UsageEventDocument } from './usage-event.js';

export type PersistUsageEventResult = 'inserted' | 'duplicate' | 'unpriced';

export interface UsageEventStore {
  persistIdempotently(event: UsageEvent): Promise<PersistUsageEventResult>;
}

export class MongoUsageEventStore implements UsageEventStore {
  constructor(
    private readonly collection: Collection<UsageEventDocument>,
    private readonly pricingCatalog: PricingCatalog,
  ) {}

  async persistIdempotently(event: UsageEvent): Promise<PersistUsageEventResult> {
    const existing = await this.collection.findOne(
      { _id: event.eventId },
      { projection: { pricingStatus: 1 } },
    );
    if (existing?.pricingStatus === 'priced') return 'duplicate';
    if (existing && existing.pricingStatus !== 'unpriced' && existing.pricingStatus !== undefined) {
      throw new Error('Stored usage event has an unsupported pricing status');
    }

    const rate = await this.pricingCatalog.findApplicableRate(event);
    const pricing = rate ? { recordId: rate._id, costUsd: calculateCostUsd(event, rate) } : undefined;

    if (existing) {
      if (existing.pricingStatus === 'unpriced' && !pricing) return 'duplicate';
      const pricingFilter: Filter<UsageEventDocument> = existing.pricingStatus === 'unpriced'
        ? { _id: event.eventId, pricingStatus: 'unpriced' }
        : { _id: event.eventId, pricingStatus: { $exists: false } };
      const update = await this.collection.updateOne(
        pricingFilter,
        {
          $set: {
            pricingStatus: pricing ? 'priced' : 'unpriced',
            ...(pricing ? { cost_usd: pricing.costUsd, pricingRecordId: pricing.recordId } : {}),
          },
          ...(!pricing ? { $unset: { cost_usd: '', pricingRecordId: '' } } : {}),
        },
      );
      return update.matchedCount > 0 ? (pricing ? 'inserted' : 'unpriced') : 'duplicate';
    }

    try {
      await this.collection.insertOne(toUsageEventDocument(event, pricing));
      return pricing ? 'inserted' : 'unpriced';
    } catch (error) {
      if (
        error instanceof MongoServerError &&
        error.code === 11000 &&
        error.keyPattern?._id === 1
      ) {
        return 'duplicate';
      }
      throw error;
    }
  }
}
