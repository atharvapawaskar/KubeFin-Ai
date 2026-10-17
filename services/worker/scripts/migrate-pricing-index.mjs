import { MongoClient } from 'mongodb';

const legacyIndexName = 'pricing_provider_model_effective_from_unique';
const v2IndexName = 'pricing_provider_model_currency_version_effective_from_unique_v2';
const v2IndexKeys = { provider: 1, model: 1, currency: 1, pricingVersion: 1, effectiveFrom: 1 };

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required.');

  const apply = process.argv.includes('--apply');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const db = client.db();
    const pricing = db.collection('pricing');
    const collectionExists = await db.listCollections({ name: 'pricing' }, { nameOnly: true }).hasNext();
    const indexes = collectionExists ? await pricing.indexes() : [];
    const legacy = indexes.find((index) => index.name === legacyIndexName);
    const v2 = indexes.find((index) => index.name === v2IndexName);

    if (v2 && (
      JSON.stringify(v2.key) !== JSON.stringify(v2IndexKeys) ||
      v2.unique !== true ||
      JSON.stringify(v2.partialFilterExpression) !== JSON.stringify({ pricingVersion: 2 })
    )) {
      throw new Error('The v2 pricing index name exists with a different definition; inspect MongoDB indexes before proceeding.');
    }

    process.stdout.write(`${legacy ? 'Legacy unique index found' : 'Legacy unique index not found'}; ${v2 ? 'v2 index already exists' : 'v2 index needs creation'}.\n`);
    if (!apply) {
      process.stdout.write(`Dry run only. With --apply, create ${v2IndexName}${legacy ? ` and then drop ${legacyIndexName}` : ''}. No pricing documents are changed.\n`);
      return;
    }

    if (!v2) {
      await pricing.createIndex(v2IndexKeys, {
        unique: true,
        name: v2IndexName,
        partialFilterExpression: { pricingVersion: 2 },
      });
    }
    if (legacy) await pricing.dropIndex(legacyIndexName);
    process.stdout.write('Pricing indexes are ready for currency-aware v2 rates.\n');
  } finally {
    await client.close();
  }
}

main().catch(() => {
  process.stderr.write('Pricing index migration failed; inspect the pricing collection indexes and data before retrying.\n');
  process.exitCode = 1;
});
