import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9090),
    MONGODB_URI: z.string().min(1).refine((value) => /^mongodb(?:\+srv)?:\/\//.test(value), {
      message: 'must use mongodb:// or mongodb+srv://',
    }),
    REDIS_URL: z.string().min(1).refine((value) => /^rediss?:\/\//.test(value), {
      message: 'must use redis:// or rediss://',
    }),
    REDIS_USAGE_STREAM: z.string().min(1).max(128).default('usage-events'),
    REDIS_USAGE_GROUP: z.string().min(1).max(128).default('kubefin-worker-v1'),
    PRICING_CURRENCY: z.string().refine(
      (currency) => Intl.supportedValuesOf('currency').includes(currency),
      'must be a supported ISO 4217 currency code',
    ).default('INR'),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    WORKER_BLOCK_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
    WORKER_CLAIM_IDLE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    WORKER_MAX_DELIVERIES: z.coerce.number().int().min(1).max(100).default(5),
    WORKER_MAX_EVENT_BYTES: z.coerce.number().int().min(1_024).max(262_144).default(262_144),
  })
  .superRefine((config, context) => {
    if (config.PORT === config.METRICS_PORT) {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_PORT'],
        message: 'must differ from PORT so metrics use a separate listener',
      });
    }
  });

export type WorkerConfig = z.infer<typeof environmentSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  return environmentSchema.parse(environment);
}
