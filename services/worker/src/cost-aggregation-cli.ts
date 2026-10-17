import { makeAggregationWindows, type AggregationGranularity } from './cost-aggregation.js';

export interface CostAggregationCliOptions {
  granularity: AggregationGranularity;
  from: Date;
  to: Date;
  apply: boolean;
  pruneBefore?: Date;
}

export function parseCostAggregationArgs(args: string[]): CostAggregationCliOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      if (apply) throw new Error('Option --apply may only be specified once.');
      apply = true;
      continue;
    }
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument ?? ''}`);
    const key = argument.slice(2);
    if (!['granularity', 'from', 'to', 'prune-before'].includes(key)) throw new Error(`Unknown option: ${argument}`);
    if (values.has(key)) throw new Error(`Option ${argument} may only be specified once.`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option ${argument} requires a value.`);
    values.set(key, value);
    index += 1;
  }

  const granularity = values.get('granularity');
  if (granularity !== 'hour' && granularity !== 'day') {
    throw new Error('Use --granularity hour or --granularity day.');
  }
  const fromValue = values.get('from');
  const toValue = values.get('to');
  if (!fromValue || !toValue) throw new Error('Both --from and --to are required (UTC ISO timestamps).');
  const from = new Date(fromValue);
  const to = new Date(toValue);
  makeAggregationWindows(from, to, granularity);
  const pruneValue = values.get('prune-before');
  if (!pruneValue) return { granularity, from, to, apply };
  const pruneBefore = new Date(pruneValue);
  if (!Number.isFinite(pruneBefore.getTime()) || pruneBefore.getTime() > Date.now()) {
    throw new Error('--prune-before must be a valid timestamp in the past.');
  }
  return { granularity, from, to, apply, pruneBefore };
}
