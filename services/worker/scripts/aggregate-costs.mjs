import { MongoClient } from 'mongodb';
import { parseCostAggregationArgs } from '../dist/src/cost-aggregation-cli.js';
import { makeAggregationWindows, MongoCostAggregationStore } from '../dist/src/cost-aggregation.js';

async function main() {
  let options;
  try {
    options = parseCostAggregationArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n`);
    process.stderr.write('Usage: npm run costs:aggregate -- --granularity hour|day --from <UTC ISO> --to <UTC ISO> [--prune-before <UTC ISO>] [--apply]\n');
    process.exitCode = 2;
    return;
  }

  const windows = makeAggregationWindows(options.from, options.to, options.granularity);
  if (!options.apply) {
    if (options.pruneBefore) {
      process.stdout.write(`Dry run: would remove superseded generations older than ${options.pruneBefore.toISOString()} for ${windows.length} ${options.granularity} UTC window(s). Active generations are preserved.\n`);
    } else {
      process.stdout.write(`Dry run: would rebuild ${windows.length} ${options.granularity} UTC window(s) from ${options.from.toISOString()} through ${options.to.toISOString()} (end exclusive).\n`);
    }
    process.stdout.write('Pass --apply to connect to MongoDB and perform this operation.\n');
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required with --apply.');
  const client = new MongoClient(uri, {
    connectTimeoutMS: 2_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 0,
  });
  try {
    await client.connect();
    const db = client.db();
    const store = new MongoCostAggregationStore(
      db.collection('usage_events'),
      db.collection('cost_aggregations'),
      db.collection('cost_aggregation_windows'),
    );
    await store.ensureIndexes();
    if (options.pruneBefore) {
      const deleted = await store.pruneSupersededGenerations(windows, options.pruneBefore);
      process.stdout.write(`Removed ${deleted} superseded snapshot document(s); active generations were preserved.\n`);
      return;
    }
    let published = 0;
    let busy = 0;
    for (const window of windows) {
      const result = await store.rebuildWindow(window);
      if (result === 'published') published += 1;
      else busy += 1;
    }
    process.stdout.write(`Published ${published}/${windows.length} ${options.granularity} rollup snapshot(s); ${busy} window(s) were already leased and skipped.\n`);
    if (busy > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Cost aggregation failed: ${error instanceof Error ? error.message : 'unexpected error'}\n`);
  process.exitCode = 1;
});
