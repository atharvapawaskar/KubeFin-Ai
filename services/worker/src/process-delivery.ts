/** A delivery after a transport adapter has handed it to the Worker. */
export interface EventDelivery {
  id: string;
  payload: unknown;
}

export type EventValidation<TEvent> =
  | { valid: true; event: TEvent }
  | { valid: false; issues: readonly unknown[] };

export interface DeliveryProcessor<TEvent> {
  validate: (payload: unknown) => EventValidation<TEvent> | Promise<EventValidation<TEvent>>;
  /** Must apply the approved event idempotency rule in its concrete adapter. */
  persistIdempotently: (event: TEvent) => Promise<'inserted' | 'duplicate'>;
  /** The adapter owns the approved DLQ key and serialized envelope. */
  deadLetter: (delivery: EventDelivery, issues: readonly unknown[]) => Promise<void>;
  acknowledge: (deliveryId: string) => Promise<void>;
}

export type DeliveryOutcome = 'inserted' | 'duplicate' | 'dead-lettered';

/**
 * Process one delivery without deciding its transport, event, database, or DLQ schema.
 * A delivery is acknowledged only after persistence or the DLQ write completes.
 * Dependency failures propagate so the transport adapter can leave the delivery
 * pending and apply the contract-approved retry and recovery policy.
 */
export async function processDelivery<TEvent>(
  delivery: EventDelivery,
  processor: DeliveryProcessor<TEvent>,
): Promise<DeliveryOutcome> {
  const validation = await processor.validate(delivery.payload);

  if (!validation.valid) {
    await processor.deadLetter(delivery, validation.issues);
    await processor.acknowledge(delivery.id);
    return 'dead-lettered';
  }

  const persistence = await processor.persistIdempotently(validation.event);
  await processor.acknowledge(delivery.id);
  return persistence;
}
