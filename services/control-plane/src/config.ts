import { z } from 'zod';

const EnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).max(128).optional(),
  CONTROL_PLANE_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CONTROL_PLANE_HOST: z.string().min(1).default('0.0.0.0'),
  JWT_ISSUER: z.url({ protocol: /^https$/ }),
  JWT_AUDIENCE: z.string().min(1).max(256),
  JWT_JWKS_URL: z.url({ protocol: /^https$/ }),
  JWT_TENANT_CLAIM: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  CURSOR_SIGNING_KEY: z.string().min(32),
});

export interface ControlPlaneConfig {
  mongoUri: string;
  mongoDb?: string;
  host: string;
  port: number;
  jwtIssuer: string;
  jwtAudience: string;
  jwtJwksUrl: string;
  jwtTenantClaim: string;
  cursorSigningKey: string;
}

export function parseConfig(env: NodeJS.ProcessEnv): ControlPlaneConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid Control Plane configuration: ${result.error.issues.map((issue) => issue.path.join('.') || 'environment').join(', ')}`);
  }
  const value = result.data;
  return {
    mongoUri: value.MONGODB_URI,
    ...(value.MONGODB_DB ? { mongoDb: value.MONGODB_DB } : {}),
    host: value.CONTROL_PLANE_HOST,
    port: value.CONTROL_PLANE_PORT,
    jwtIssuer: value.JWT_ISSUER,
    jwtAudience: value.JWT_AUDIENCE,
    jwtJwksUrl: value.JWT_JWKS_URL,
    jwtTenantClaim: value.JWT_TENANT_CLAIM,
    cursorSigningKey: value.CURSOR_SIGNING_KEY,
  };
}
