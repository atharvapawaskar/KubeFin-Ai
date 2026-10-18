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
    KUBERNETES_DISCOVERY_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    KUBERNETES_CLUSTER_ID: z.string().min(1).max(128).optional(),
    KUBERNETES_TENANT_LABEL_KEY: z.string().min(1).max(253).optional(),
    KUBERNETES_TEAM_LABEL_KEY: z.string().min(1).max(253).optional(),
    KUBERNETES_WORKLOAD_LABEL_KEY: z.string().min(1).max(253).optional(),
    KUBERNETES_SERVICE_HOST: z.string().min(1).max(253).optional(),
    KUBERNETES_API_HOST: z.string().min(1).max(253).optional(),
    KUBERNETES_API_PORT: z.coerce.number().int().min(1).max(65_535).default(443),
    KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE: z.string().min(1).default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
    KUBERNETES_SERVICE_ACCOUNT_CA_FILE: z.string().min(1).default('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
  })
  .superRefine((config, context) => {
    if (config.PORT === config.METRICS_PORT) {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_PORT'],
        message: 'must differ from PORT so metrics use a separate listener',
      });
    }
    if (config.KUBERNETES_DISCOVERY_ENABLED) {
      for (const key of [
        'KUBERNETES_CLUSTER_ID',
        'KUBERNETES_TENANT_LABEL_KEY',
        'KUBERNETES_TEAM_LABEL_KEY',
        'KUBERNETES_WORKLOAD_LABEL_KEY',
      ] as const) {
        if (!config[key]) {
          context.addIssue({ code: 'custom', path: [key], message: 'is required when Kubernetes discovery is enabled' });
        }
      }
      if (!config.KUBERNETES_API_HOST && !config.KUBERNETES_SERVICE_HOST) {
        context.addIssue({
          code: 'custom',
          path: ['KUBERNETES_API_HOST'],
          message: 'must be set explicitly or provided by the in-cluster Kubernetes environment',
        });
      }
    }
  });

export type WorkerConfig = z.infer<typeof environmentSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  return environmentSchema.parse(environment);
}
