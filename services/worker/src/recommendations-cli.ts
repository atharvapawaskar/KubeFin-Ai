import { z } from 'zod';

const optionsSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/),
  apply: z.boolean(),
}).strict();

export interface RecommendationCliOptions {
  from: Date;
  to: Date;
  apply: boolean;
}

export function parseRecommendationArgs(args: string[]): RecommendationCliOptions {
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
    if (key !== 'from' && key !== 'to') throw new Error(`Unknown option: ${argument}`);
    if (values.has(key)) throw new Error(`Option ${argument} may only be specified once.`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option ${argument} requires a value.`);
    values.set(key, value);
    index += 1;
  }
  const parsed = optionsSchema.safeParse({ from: values.get('from'), to: values.get('to'), apply });
  if (!parsed.success) throw new Error('Provide --from and --to as UTC midnight timestamps (YYYY-MM-DDT00:00:00Z).');
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (to.getTime() - from.getTime() !== 30 * 86_400_000) {
    throw new Error('The observation range must contain exactly 30 complete UTC days.');
  }
  return { from, to, apply: parsed.data.apply };
}
