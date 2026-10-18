import { MongoClient } from 'mongodb';
import {
  ensureRecommendationIndexes,
  generateAndStoreRecommendations,
  MongoRecommendationSource,
} from '../dist/src/recommendations.js';
import { parseRecommendationArgs } from '../dist/src/recommendations-cli.js';

async function main() {
  let options;
  try {
    options = parseRecommendationArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n`);
    process.stderr.write('Usage: npm run recommendations:generate -- --from <UTC midnight> --to <UTC midnight> [--apply]\n');
    process.exitCode = 2;
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required.');
  const client = new MongoClient(uri, { connectTimeoutMS: 2_000, serverSelectionTimeoutMS: 5_000, maxPoolSize: 5 });
  try {
    await client.connect();
    const db = client.db();
    const source = new MongoRecommendationSource({
      aggregations: db.collection('cost_aggregations'),
      windows: db.collection('cost_aggregation_windows'),
      pricing: db.collection('pricing'),
    });
    const target = db.collection('recommendations');
    if (options.apply) await ensureRecommendationIndexes(target);
    const data = await source.load(options.from, options.to);
    const recommendations = await generateAndStoreRecommendations(
      { ...data, from: options.from, to: options.to, createdAt: new Date() },
      target,
      options.apply,
    );
    const displayed = recommendations.slice(0, 100).map((item) => ({ ...item, estimatedMonthlySavingsAmount: item.estimatedMonthlySavingsAmount.toString(), evidence: { ...item.evidence, baselineCostAmount: item.evidence.baselineCostAmount.toString(), candidateCostAmount: item.evidence.candidateCostAmount.toString() } }));
    process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'applied' : 'preview', from: options.from.toISOString(), to: options.to.toISOString(), count: recommendations.length, displayed: displayed.length, truncated: recommendations.length > displayed.length, items: displayed }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Recommendation generation failed: ${error instanceof Error ? error.message : 'unexpected error'}\n`);
  process.exitCode = 1;
});
