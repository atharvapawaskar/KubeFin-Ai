import { MongoClient } from 'mongodb';
import { calculateCostAmount } from '../dist/src/cost-engine.js';

function getArgument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required.');
  const batchArg = getArgument('--batch-size');
  const batchSize = batchArg === undefined ? 100 : Number(batchArg);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('--batch-size must be an integer from 1 to 1000.');
  }

  const apply = process.argv.includes('--apply');
  const currency = process.env.PRICING_CURRENCY ?? 'INR';
  if (!Intl.supportedValuesOf('currency').includes(currency)) throw new Error('PRICING_CURRENCY must be a supported ISO 4217 currency code.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  let priced = 0;
  let unpriced = 0;
  let legacyUnconverted = 0;
  let updated = 0;
  try {
    await client.connect();
    const db = client.db();
    const events = db.collection('usage_events');
    const pricing = db.collection('pricing');
    await pricing.createIndex(
      { provider: 1, model: 1, currency: 1, pricingVersion: 1, effectiveFrom: 1 },
      {
        unique: true,
        name: 'pricing_provider_model_currency_version_effective_from_unique_v2',
        partialFilterExpression: { pricingVersion: 2 },
      },
    );

    let lastId;
    while (true) {
      const needsPricing = { $or: [
        { pricingStatus: { $exists: false } },
        { pricingStatus: 'unpriced' },
        { cost_usd: { $exists: true } },
      ] };
      const filter = lastId === undefined
        ? needsPricing
        : { $and: [needsPricing, { _id: { $gt: lastId } }] };
      const batch = await events.find(filter).sort({ _id: 1 }).limit(batchSize).toArray();
      if (batch.length === 0) break;
      lastId = batch.at(-1)._id;

      for (const stored of batch) {
        const occurredAt = new Date(stored.occurredAt);
        const matches = await pricing.find({
          provider: stored.provider,
          model: stored.model,
          currency,
          pricingVersion: 2,
          effectiveFrom: { $lte: occurredAt },
          $or: [{ effectiveTo: { $gt: occurredAt } }, { effectiveTo: { $exists: false } }],
        }).sort({ effectiveFrom: -1 }).limit(2).toArray();
        if (matches.length > 1) throw new Error(`Overlapping pricing intervals for event ${stored._id}.`);

        const matched = matches[0];
        const isLegacyUsd = stored.cost_usd !== undefined;
        const filter = isLegacyUsd
          ? { _id: stored._id, cost_usd: { $exists: true } }
          : stored.pricingStatus === 'unpriced'
            ? { _id: stored._id, pricingStatus: 'unpriced' }
            : { _id: stored._id, pricingStatus: { $exists: false } };
        if (!matched) {
          if (isLegacyUsd) legacyUnconverted += 1;
          else unpriced += 1;
          if (apply && stored.pricingStatus === undefined) {
            const result = await events.updateOne(filter, { $set: { pricingStatus: 'unpriced' } });
            updated += result.modifiedCount;
          }
          continue;
        }

        const event = { ...stored, eventId: stored._id };
        const costAmount = calculateCostAmount(event, matched);
        priced += 1;
        if (apply) {
          const result = await events.updateOne(filter, {
            $set: { pricingStatus: 'priced', costAmount, costCurrency: matched.currency, pricingRecordId: matched._id },
            $unset: { cost_usd: '', pricingReason: '' },
          });
          updated += result.modifiedCount;
        }
      }
    }

    process.stdout.write(`Backfill scan: ${priced} priceable, ${unpriced} unpriced, ${legacyUnconverted} legacy USD records awaiting a ${currency} rate, ${updated} updated.\n`);
    if (!apply) process.stdout.write('Dry run only. Pass --apply to update eligible usage events.\n');
  } finally {
    await client.close();
  }
}

main().catch(() => {
  process.stderr.write('Cost backfill failed; verify MongoDB, pricing intervals, and stored usage events.\n');
  process.exitCode = 1;
});
