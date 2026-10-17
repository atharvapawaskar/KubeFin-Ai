import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { processDelivery, type EventValidation } from './process-delivery.js';
import { usageEventSchema, type UsageEvent } from './usage-event.js';

export interface StreamEntry {
  id: string;
  fields: Readonly<Record<string, string>>;
}

export interface PendingEntry {
  id: string;
  deliveries: number;
  idleMs: number;
}

export interface DeadLetterRecord {
  sourceStream: string;
  sourceEntryId: string;
  failedAt: string;
  failureCode: 'INVALID_STREAM_ENVELOPE' | 'INVALID_EVENT_SCHEMA' | 'PERSISTENCE_RETRIES_EXHAUSTED';
  attempts: number;
  payload?: string;
  payloadBytes: number;
  payloadSha256: string;
}

export interface UsageStreamPort {
  createGroup(stream: string, group: string): Promise<void>;
  readNew(stream: string, group: string, consumer: string, count: number, blockMs: number): Promise<StreamEntry[]>;
  claimPending(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    startId: string,
    count: number,
  ): Promise<{ nextId: string; entries: StreamEntry[]; deletedIds: string[] }>;
  getPending(stream: string, group: string, entryId: string): Promise<PendingEntry | undefined>;
  acknowledge(stream: string, group: string, entryId: string): Promise<void>;
  deadLetterAndAcknowledge(
    stream: string,
    group: string,
    entryId: string,
    record: DeadLetterRecord,
  ): Promise<void>;
}

export interface UsageEventSink {
  persistIdempotently(event: UsageEvent): Promise<'inserted' | 'duplicate'>;
}

export interface ConsumerLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface UsageStreamConsumerConfig {
  stream: string;
  group: string;
  consumer: string;
  batchSize: number;
  blockMs: number;
  claimIdleMs: number;
  maxDeliveries: number;
  maxPayloadBytes: number;
}

export interface UsageStreamConsumerDependencies {
  stream: UsageStreamPort;
  sink: UsageEventSink;
  logger: ConsumerLogger;
  config: UsageStreamConsumerConfig;
  onOutcome?: (outcome: 'inserted' | 'duplicate' | 'dead_lettered' | 'retrying') => void;
}

export class UsageStreamConsumer {
  constructor(private readonly dependencies: UsageStreamConsumerDependencies) {}

  async run(signal: AbortSignal): Promise<void> {
    const { config, stream } = this.dependencies;
    await stream.createGroup(config.stream, config.group);
    let claimCursor = '0-0';

    while (!signal.aborted) {
      try {
        const claimed = await stream.claimPending(
          config.stream,
          config.group,
          config.consumer,
          config.claimIdleMs,
          claimCursor,
          config.batchSize,
        );

        for (const entry of claimed.entries) {
          if (signal.aborted) return;
          await this.processEntry(entry);
        }

        for (const id of claimed.deletedIds) {
          this.dependencies.logger.error(
            { streamEntryId: id },
            'Pending Redis stream entry was removed before the Worker recovered it',
          );
        }

        claimCursor = claimed.nextId;
        if (claimCursor !== '0-0') continue;

        const fresh = await stream.readNew(
          config.stream,
          config.group,
          config.consumer,
          config.batchSize,
          config.blockMs,
        );
        for (const entry of fresh) {
          if (signal.aborted) return;
          await this.processEntry(entry);
        }
      } catch {
        this.dependencies.logger.warn({}, 'Redis stream polling failed; retrying with backoff');
        await delay(1_000, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  private async processEntry(entry: StreamEntry): Promise<void> {
    const { config, stream, sink, logger } = this.dependencies;
    const rawPayload = entry.fields.payload;
    let persisted = false;
    let persistenceFailed = false;
    let deadLettered = false;

    const validation = (payload: unknown): EventValidation<UsageEvent> => {
      if (typeof payload !== 'string') {
        return { valid: false, issues: [{ code: 'INVALID_STREAM_ENVELOPE' }] };
      }
      if (Buffer.byteLength(payload, 'utf8') > config.maxPayloadBytes) {
        return { valid: false, issues: [{ code: 'INVALID_STREAM_ENVELOPE' }] };
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(payload);
      } catch {
        return { valid: false, issues: [{ code: 'INVALID_EVENT_SCHEMA' }] };
      }

      const parsed = usageEventSchema.safeParse(decoded);
      if (!parsed.success) {
        return {
          valid: false,
          issues: parsed.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map(String),
          })),
        };
      }
      return { valid: true, event: parsed.data };
    };

    try {
      const outcome = await processDelivery(
        { id: entry.id, payload: rawPayload },
        {
          validate: validation,
          persistIdempotently: async (event) => {
            try {
              const result = await sink.persistIdempotently(event);
              persisted = true;
              return result;
            } catch (error) {
              persistenceFailed = true;
              throw error;
            }
          },
          deadLetter: async (_delivery, issues) => {
            const pending = await stream.getPending(config.stream, config.group, entry.id);
            await stream.deadLetterAndAcknowledge(config.stream, config.group, entry.id, {
              sourceStream: config.stream,
              sourceEntryId: entry.id,
              failedAt: new Date().toISOString(),
              failureCode: issues.some((issue) => (issue as { code?: string }).code === 'INVALID_STREAM_ENVELOPE')
                ? 'INVALID_STREAM_ENVELOPE'
                : 'INVALID_EVENT_SCHEMA',
              attempts: pending?.deliveries ?? 1,
              ...this.payloadForDeadLetter(rawPayload, false),
            });
            deadLettered = true;
          },
          acknowledge: async (id) => {
            if (!deadLettered) await stream.acknowledge(config.stream, config.group, id);
          },
        },
      );
      this.dependencies.onOutcome?.(outcome === 'dead-lettered' ? 'dead_lettered' : outcome);
    } catch {
      if (persisted || deadLettered) {
        // The durable operation succeeded; the acknowledgement may have failed.
        // Redelivery is safe because MongoDB uses eventId as its unique _id.
        logger.warn({ streamEntryId: entry.id }, 'Usage event acknowledgement failed; delivery remains recoverable');
        return;
      }

      const pending = await stream.getPending(config.stream, config.group, entry.id).catch(() => undefined);
      if (persistenceFailed && pending && pending.deliveries >= config.maxDeliveries && typeof rawPayload === 'string') {
        try {
          await stream.deadLetterAndAcknowledge(config.stream, config.group, entry.id, {
            sourceStream: config.stream,
            sourceEntryId: entry.id,
            failedAt: new Date().toISOString(),
            failureCode: 'PERSISTENCE_RETRIES_EXHAUSTED',
            attempts: pending.deliveries,
            ...this.payloadForDeadLetter(rawPayload, true),
          });
          this.dependencies.onOutcome?.('dead_lettered');
          return;
        } catch {
          // Keep the pending entry if the DLQ write or acknowledgement fails.
        }
      }

      this.dependencies.onOutcome?.('retrying');
      logger.warn({ streamEntryId: entry.id }, 'Usage event processing failed; delivery left pending for retry');
    }
  }

  private payloadForDeadLetter(
    payload: string | undefined,
    includeBody: boolean,
  ): Pick<DeadLetterRecord, 'payload' | 'payloadBytes' | 'payloadSha256'> {
    const bytes = Buffer.from(payload ?? '', 'utf8');
    const payloadBytes = bytes.byteLength;
    const payloadSha256 = createHash('sha256').update(bytes).digest('hex');
    if (includeBody && payloadBytes <= this.dependencies.config.maxPayloadBytes) {
      return { payload: payload ?? '', payloadBytes, payloadSha256 };
    }
    return { payloadBytes, payloadSha256 };
  }
}
