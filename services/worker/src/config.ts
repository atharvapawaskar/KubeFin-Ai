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
