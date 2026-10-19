import { randomUUID } from 'node:crypto';

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  tenantId: string;
  provider: string;
  model: string;
  usage: UsageTokens;
  requestId?: string;
  teamId?: string;
  workloadId?: string;
}

export interface CreateUsageEventParams {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  eventId?: string;
  occurredAt?: string;
  requestId?: string;
  teamId?: string;
  workloadId?: string;
}

export const MAX_USAGE_EVENT_BYTES = 262_144; // 256 KiB limit per contracts/events/usage-event.v1.json

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function createUsageEvent(params: CreateUsageEventParams): UsageEvent {
  // Validate custom eventId or generate UUID once per billable provider call
  let eventId: string;
  if (params.eventId !== undefined) {
    if (typeof params.eventId !== 'string' || !UUID_REGEX.test(params.eventId)) {
      throw new Error(`Invalid eventId: "${params.eventId}". Must be a valid UUID string.`);
    }
    eventId = params.eventId;
  } else {
    eventId = randomUUID();
  }

  // Validate custom occurredAt or generate ISO 8601 UTC timestamp ending in Z
  let occurredAt: string;
  if (params.occurredAt !== undefined) {
    if (
      typeof params.occurredAt !== 'string' ||
      !ISO_UTC_REGEX.test(params.occurredAt) ||
      isNaN(Date.parse(params.occurredAt))
    ) {
      throw new Error(
        `Invalid occurredAt: "${params.occurredAt}". Must be a valid ISO 8601 UTC timestamp ending in Z.`
      );
    }
    occurredAt = params.occurredAt;
  } else {
    occurredAt = new Date().toISOString();
  }

  // Validate non-negative safe integers
  if (
    typeof params.inputTokens !== 'number' ||
    !Number.isInteger(params.inputTokens) ||
    params.inputTokens < 0 ||
    params.inputTokens > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `Invalid inputTokens: ${params.inputTokens}. Must be a non-negative safe integer.`
    );
  }

  if (
    typeof params.outputTokens !== 'number' ||
    !Number.isInteger(params.outputTokens) ||
    params.outputTokens < 0 ||
    params.outputTokens > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `Invalid outputTokens: ${params.outputTokens}. Must be a non-negative safe integer.`
    );
  }

  if (!params.tenantId || typeof params.tenantId !== 'string' || params.tenantId.trim().length === 0) {
    throw new Error('tenantId is required and must be a non-empty string');
  }
  if (params.tenantId.trim().length > 256) {
    throw new Error('tenantId exceeds maximum length of 256 characters');
  }

  if (!params.provider || typeof params.provider !== 'string' || params.provider.trim().length === 0) {
    throw new Error('provider is required and must be a non-empty string');
  }
  if (params.provider.trim().length > 128) {
    throw new Error('provider exceeds maximum length of 128 characters');
  }

  if (!params.model || typeof params.model !== 'string' || params.model.trim().length === 0) {
    throw new Error('model is required and must be a non-empty string');
  }
  if (params.model.trim().length > 256) {
    throw new Error('model exceeds maximum length of 256 characters');
  }

  const event: UsageEvent = {
    schemaVersion: 1,
    eventId,
    occurredAt,
    tenantId: params.tenantId.trim(),
    provider: params.provider.trim(),
    model: params.model.trim(),
    usage: {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    },
  };

  // Validate optional attribution identifiers: reject invalid values; do not silently truncate
  if (params.requestId !== undefined && params.requestId !== null) {
    if (typeof params.requestId !== 'string' || params.requestId.trim().length === 0) {
      throw new Error('requestId must be a non-empty string if provided');
    }
    if (params.requestId.trim().length > 256) {
      throw new Error('requestId exceeds maximum length of 256 characters');
    }
    event.requestId = params.requestId.trim();
  }

  if (params.teamId !== undefined && params.teamId !== null) {
    if (typeof params.teamId !== 'string' || params.teamId.trim().length === 0) {
      throw new Error('teamId must be a non-empty string if provided');
    }
    if (params.teamId.trim().length > 256) {
      throw new Error('teamId exceeds maximum length of 256 characters');
    }
    event.teamId = params.teamId.trim();
  }

  if (params.workloadId !== undefined && params.workloadId !== null) {
    if (typeof params.workloadId !== 'string' || params.workloadId.trim().length === 0) {
      throw new Error('workloadId must be a non-empty string if provided');
    }
    if (params.workloadId.trim().length > 256) {
      throw new Error('workloadId exceeds maximum length of 256 characters');
    }
    event.workloadId = params.workloadId.trim();
  }

  return event;
}
