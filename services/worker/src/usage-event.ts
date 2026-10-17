import { z } from 'zod';
import type { Decimal128 } from 'mongodb';

/** Runtime counterpart of contracts/events/usage-event.v1.json. */
export const usageEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
    tenantId: z.string().min(1).max(256),
    teamId: z.string().min(1).max(256).optional(),
    workloadId: z.string().min(1).max(256).optional(),
    requestId: z.string().min(1).max(256).optional(),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

export type UsageEvent = z.infer<typeof usageEventSchema>;

export interface UsageEventDocument extends Omit<UsageEvent, 'eventId'> {
  _id: string;
  receivedAt: string;
  pricingStatus: 'priced' | 'unpriced';
  costAmount?: Decimal128;
  costCurrency?: string;
  pricingRecordId?: string;
}

export function toUsageEventDocument(
  event: UsageEvent,
  pricing: { recordId: string; amount: Decimal128; currency: string } | undefined,
  receivedAt = new Date(),
): UsageEventDocument {
  const { eventId, ...fields } = event;
  return {
    ...fields,
    _id: eventId,
    receivedAt: receivedAt.toISOString(),
    pricingStatus: pricing ? 'priced' : 'unpriced',
    ...(pricing ? { costAmount: pricing.amount, costCurrency: pricing.currency, pricingRecordId: pricing.recordId } : {}),
  };
}
