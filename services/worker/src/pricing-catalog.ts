import type { Collection } from 'mongodb';
import type { UsageEvent } from './usage-event.js';

export interface PricingRate {
  _id: string;
  pricingVersion: 2;
  provider: string;
  model: string;
  currency: string;
  inputRateMicrosPerMillionTokens: number;
  outputRateMicrosPerMillionTokens: number;
  effectiveFrom: Date;
  effectiveTo?: Date;
  sourceUrl: string;
  sourceVerifiedAt: Date;
}

export interface PricingCatalog {
  findApplicableRate(event: UsageEvent): Promise<PricingRate | undefined>;
}

export class MongoPricingCatalog implements PricingCatalog {
  constructor(
    private readonly collection: Collection<PricingRate>,
    private readonly currency: string,
  ) {}

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { provider: 1, model: 1, currency: 1, pricingVersion: 1, effectiveFrom: 1 },
      {
        unique: true,
        name: 'pricing_provider_model_currency_version_effective_from_unique_v2',
        partialFilterExpression: { pricingVersion: 2 },
      },
    );
  }

  async findApplicableRate(event: UsageEvent): Promise<PricingRate | undefined> {
    const occurredAt = new Date(event.occurredAt);
    const matches = await this.collection
      .find({
        provider: event.provider,
        model: event.model,
        currency: this.currency,
        pricingVersion: 2,
        effectiveFrom: { $lte: occurredAt },
        $or: [{ effectiveTo: { $gt: occurredAt } }, { effectiveTo: { $exists: false } }],
      })
      .sort({ effectiveFrom: -1 })
      .limit(2)
      .toArray();

    if (matches.length > 1) {
      throw new Error('Pricing intervals overlap for provider, model, and currency');
    }
    return matches[0];
  }
}
