import { createClient } from 'redis';
import type { UsageEvent } from './usage-event.js';

export interface PublisherLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export function sanitizeErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  let message = err instanceof Error ? err.message : String(err);

  // Redact passwords from connection strings (e.g., redis://:password@host or redis://user:password@host)
  message = message.replace(/(redis:\/\/[^:]*:)([^@]+)(@)/gi, '$1***$3');

  // Redact Bearer tokens
  message = message.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1***');

  // Redact API keys in query parameters (e.g., ?key=... or &api_key=...)
  message = message.replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1***');

  // Redact potential API keys (long alphanumeric strings that are not UUIDs)
  message = message.replace(/\b([a-zA-Z0-9_-]{24,})\b/g, (match) => {
    // Keep UUIDs intact
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match)) {
      return match;
    }
    return match.slice(0, 4) + '***' + match.slice(-4);
  });

  return message;
}

export interface RedisClientLike {
  isOpen: boolean;
  connect(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
  ): Promise<string>;
  on?(event: string, listener: (...args: any[]) => void): void;
}

export interface RedisPublisherOptions {
  url: string;
  stream?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  client?: RedisClientLike;
  logger?: PublisherLogger;
}

export interface UsageEventPublisher {
  publish(event: UsageEvent): Promise<{ success: boolean; entryId?: string; error?: string }>;
  close(): Promise<void>;
}

export class RedisUsageEventPublisher implements UsageEventPublisher {
  private readonly stream: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly client: RedisClientLike;
  private readonly logger: PublisherLogger;
  private connectingPromise: Promise<void> | null = null;
  private isClosed = false;

  constructor(options: RedisPublisherOptions) {
    this.stream = options.stream || 'usage-events';
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 100;

    this.logger = options.logger || {
      info: (obj, msg) => console.log(msg, obj),
      warn: (obj, msg) => console.warn(msg, obj),
      error: (obj, msg) => console.error(msg, obj),
    };

    if (options.client) {
      this.client = options.client;
    } else {
      const client = createClient({ url: options.url });
      // Attach background error listener so unhandled client errors don't crash process
      client.on('error', (err) => {
        this.logger.warn(
          { error: sanitizeErrorMessage(err), stream: this.stream },
          'Redis client background error'
        );
      });
      this.client = client as unknown as RedisClientLike;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isClosed) {
      throw new Error('Redis publisher is closed');
    }

    if (this.client.isOpen) {
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      try {
        if (!this.client.isOpen) {
          await this.client.connect();
        }
      } finally {
        this.connectingPromise = null;
      }
    })();

    return this.connectingPromise;
  }

  /**
   * Publishes a serialized usage event to the Redis Stream named usage-events
   * with entry field 'payload'.
   *
   * Reuses the event.eventId unchanged across all retry attempts.
   */
  async publish(event: UsageEvent): Promise<{ success: boolean; entryId?: string; error?: string }> {
    if (this.isClosed) {
      return { success: false, error: 'Redis publisher is closed' };
    }

    const payload = JSON.stringify(event);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');

    // 256 KiB limit per contracts/events/usage-event.v1.json
    if (payloadBytes > 262_144) {
      const errorMsg = `Usage event payload size (${payloadBytes} bytes) exceeds maximum limit of 256 KiB`;
      this.logger.error(
        {
          eventId: event.eventId,
          stream: this.stream,
          payloadBytes,
          maxBytes: 262_144,
        },
        errorMsg
      );
      return { success: false, error: errorMsg };
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (this.isClosed) {
        return { success: false, error: 'Redis publisher was closed during publish attempts' };
      }

      try {
        await this.ensureConnected();

        const entryId = await this.client.xAdd(this.stream, '*', {
          payload,
        });

        this.logger.info(
          { eventId: event.eventId, stream: this.stream, entryId, attempt },
          'Usage event published to Redis stream'
        );

        return { success: true, entryId };
      } catch (err) {
        lastError = err;
        const sanitized = sanitizeErrorMessage(err);

        this.logger.warn(
          {
            eventId: event.eventId,
            stream: this.stream,
            attempt,
            maxRetries: this.maxRetries,
            error: sanitized,
          },
          'Redis stream publish attempt failed'
        );

        if (attempt < this.maxRetries && this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    }

    const sanitized = sanitizeErrorMessage(lastError);
    this.logger.error(
      {
        eventId: event.eventId,
        stream: this.stream,
        totalAttempts: this.maxRetries,
        error: sanitized,
      },
      'Failed to publish usage event to Redis stream after retries'
    );

    return { success: false, error: sanitized };
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    // Await in-flight connection attempt if any
    if (this.connectingPromise) {
      try {
        await this.connectingPromise;
      } catch {
        // Connection error during shutdown is non-fatal
      }
    }

    try {
      if (this.client.isOpen) {
        // In node-redis, quit() gracefully finishes pending commands; disconnect() aborts abruptly
        if (typeof this.client.quit === 'function') {
          await this.client.quit();
        } else if (typeof this.client.disconnect === 'function') {
          await this.client.disconnect();
        }
      }
    } catch (err) {
      this.logger.warn({ error: sanitizeErrorMessage(err) }, 'Error disconnecting Redis client');
    }
  }
}

export class NoopUsageEventPublisher implements UsageEventPublisher {
  async publish(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async close(): Promise<void> {}
}
