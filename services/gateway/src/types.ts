import type { FastifyRequest } from 'fastify';

export interface TenantIdentity {
  tenantId: string;
  apiKeyPrefix: string; // First 8 chars for logging
  teamId?: string;
  workloadId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: TenantIdentity;
  }
}