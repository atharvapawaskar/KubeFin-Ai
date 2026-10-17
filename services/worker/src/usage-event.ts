import { z } from 'zod';

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
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type UsageEvent = z.infer<typeof usageEventSchema>;

export interface UsageEventDocument extends Omit<UsageEvent, 'eventId'> {
  _id: string;
  receivedAt: string;
}

export function toUsageEventDocument(event: UsageEvent, receivedAt = new Date()): UsageEventDocument {
  const { eventId, ...fields } = event;
  return {
    ...fields,
    _id: eventId,
    receivedAt: receivedAt.toISOString(),
  };
}
