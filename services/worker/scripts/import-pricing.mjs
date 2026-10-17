import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { MongoClient } from 'mongodb';

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

function getArgument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function normalize(record) {
  return {
    ...record,
    effectiveFrom: new Date(record.effectiveFrom),
    ...(record.effectiveTo ? { effectiveTo: new Date(record.effectiveTo) } : {}),
    sourceVerifiedAt: new Date(record.sourceVerifiedAt),
  };
}

function timeRangeOverlaps(a, b) {
  const aEnd = a.effectiveTo?.getTime() ?? Infinity;
  const bEnd = b.effectiveTo?.getTime() ?? Infinity;
  return a.effectiveFrom.getTime() < bEnd && b.effectiveFrom.getTime() < aEnd;
}

function sameRate(a, b) {
  const date = (value) => value instanceof Date ? value.toISOString() : value;
  return a._id === b._id && a.pricingVersion === b.pricingVersion &&
    a.provider === b.provider && a.model === b.model && a.currency === b.currency &&
    a.inputRateMicrosPerMillionTokens === b.inputRateMicrosPerMillionTokens &&
    a.outputRateMicrosPerMillionTokens === b.outputRateMicrosPerMillionTokens &&
    date(a.effectiveFrom) === date(b.effectiveFrom) &&
    date(a.effectiveTo) === date(b.effectiveTo) &&
    a.sourceUrl === b.sourceUrl && date(a.sourceVerifiedAt) === date(b.sourceVerifiedAt);
}

async function main() {
  const file = getArgument('--file');
  if (!file) return fail('Usage: npm run pricing:import -- --file <json-file> [--apply]');
  const uri = process.env.MONGODB_URI;
  if (!uri) return fail('MONGODB_URI is required.');

  const [raw, rawSchema] = await Promise.all([
    readFile(file, 'utf8'),
    readFile(new URL('../../contracts/db/pricing.v2.json', import.meta.url), 'utf8'),
  ]);
  const records = JSON.parse(raw);
  if (!Array.isArray(records) || records.length === 0) return fail('Pricing file must contain a non-empty JSON array.');

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(rawSchema));
  for (const [index, record] of records.entries()) {
    if (!validate(record)) {
      return fail(`Pricing record ${index + 1} is invalid: ${ajv.errorsText(validate.errors)}`);
    }
    if (!Intl.supportedValuesOf('currency').includes(record.currency)) {
      return fail(`Pricing record ${index + 1} has an unsupported ISO 4217 currency code.`);
    }
  }

  const proposed = records.map(normalize);
  for (const record of proposed) {
    if (!Number.isFinite(record.effectiveFrom.getTime()) || !Number.isFinite(record.sourceVerifiedAt.getTime()) ||
        (record.effectiveTo && !Number.isFinite(record.effectiveTo.getTime())) ||
        (record.effectiveTo && record.effectiveTo <= record.effectiveFrom)) {
      return fail(`Pricing record ${record._id} has an invalid effective interval or verification date.`);
    }
  }

  for (let i = 0; i < proposed.length; i += 1) {
    for (let j = i + 1; j < proposed.length; j += 1) {
      if (proposed[i].provider === proposed[j].provider && proposed[i].model === proposed[j].model &&
          proposed[i].currency === proposed[j].currency &&
          timeRangeOverlaps(proposed[i], proposed[j])) {
        return fail(`Pricing records ${proposed[i]._id} and ${proposed[j]._id} have overlapping intervals.`);
      }
    }
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const collection = client.db().collection('pricing');
    await collection.createIndex(
      { provider: 1, model: 1, currency: 1, pricingVersion: 1, effectiveFrom: 1 },
      {
        unique: true,
        name: 'pricing_provider_model_currency_version_effective_from_unique_v2',
        partialFilterExpression: { pricingVersion: 2 },
      },
    );

    const insert = [];
    for (const record of proposed) {
      const existing = await collection.find({
        pricingVersion: 2,
        provider: record.provider,
        model: record.model,
        currency: record.currency,
      }).toArray();
      const byId = existing.find((item) => item._id === record._id);
      if (byId) {
        if (!sameRate(byId, record)) return fail(`Pricing record ${record._id} already exists with different values; rate records are immutable.`);
        continue;
      }
      if (existing.some((item) => item.currency === record.currency && timeRangeOverlaps(record, item))) {
        return fail(`Pricing record ${record._id} overlaps an existing effective interval.`);
      }
      insert.push(record);
    }

    process.stdout.write(`Validated ${records.length} pricing record(s); ${insert.length} new record(s).\n`);
    if (!process.argv.includes('--apply')) {
      process.stdout.write('Dry run only. Pass --apply to insert immutable rates.\n');
      return;
    }
    if (insert.length > 0) await collection.insertMany(insert, { ordered: true });
    process.stdout.write(`Inserted ${insert.length} pricing record(s).\n`);
  } finally {
    await client.close();
  }
}

main().catch(() => fail('Pricing import failed; verify the file, MongoDB connection, and pricing index.'));
