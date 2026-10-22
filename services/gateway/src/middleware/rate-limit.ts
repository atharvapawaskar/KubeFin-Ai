import type { FastifyRequest, FastifyReply } from 'fastify';
import { createClient } from 'redis';
import { sanitizeErrorMessage } from '../events/redis-publisher.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTimeMs: number;
  retryAfterSeconds: number;
  degraded?: boolean;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
  close(): Promise<void>;
}

export class RateLimiterStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimiterStoreError';
  }
}

export interface RateLimiterLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface MemoryRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, { count: number; expiresAt: number }>();

  constructor(options: MemoryRateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
  }

  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now >= entry.expiresAt) {
      const expiresAt = now + this.windowMs;
      this.hits.set(key, { count: 1, expiresAt });
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - 1),
        resetTimeMs: expiresAt,
        retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)),
      };
    }

    entry.count += 1;
    const allowed = entry.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - entry.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));

    return {
      allowed,
      limit: this.maxRequests,
      remaining,
      resetTimeMs: entry.expiresAt,
      retryAfterSeconds,
    };
  }

  async close(): Promise<void> {
    this.hits.clear();
  }
}

export interface RateLimitRedisClientLike {
  isOpen: boolean;
  connect(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  incr(key: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<boolean | number>;
  pTTL?(key: string): Promise<number>;
  eval?(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
}

export interface RedisRateLimiterOptions {
  url: string;
  maxRequests: number;
  windowMs: number;
  prefix?: string;
  failureMode?: 'fail-closed' | 'fail-open';
  client?: RateLimitRedisClientLike;
  logger?: RateLimiterLogger;
}

export class RedisRateLimiter implements RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly prefix: string;
  private readonly failureMode: 'fail-closed' | 'fail-open';
  private readonly client: RateLimitRedisClientLike;
  private readonly logger: RateLimiterLogger;
  private connectingPromise: Promise<void> | null = null;
  private isClosed = false;

  constructor(options: RedisRateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.prefix = options.prefix || 'ratelimit:tenant';
    this.failureMode = options.failureMode || 'fail-closed';
    this.logger = options.logger || {
      info: (obj, msg) => console.log(msg, obj),
      warn: (obj, msg) => console.warn(msg, obj),
      error: (obj, msg) => console.error(msg, obj),
    };

    if (options.client) {
      this.client = options.client;
    } else {
      const client = createClient({
        url: options.url,
        socket: {
          connectTimeout: 2000,
          reconnectStrategy: (retries) => {
            if (retries > 1) {
              return new Error('Redis connection retries exhausted');
            }
            return 50;
          },
        },
      });
      client.on('error', (err) => {
        this.logger.warn(
          { error: sanitizeErrorMessage(err), prefix: this.prefix },
          'Rate limiter Redis client background error'
        );
      });
      this.client = client as unknown as RateLimitRedisClientLike;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isClosed) {
      throw new RateLimiterStoreError('Rate limiter Redis client is closed');
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

  async check(key: string): Promise<RateLimitResult> {
    if (this.isClosed) {
      if (this.failureMode === 'fail-open') {
        return {
          allowed: true,
          limit: this.maxRequests,
          remaining: this.maxRequests,
          resetTimeMs: Date.now() + this.windowMs,
          retryAfterSeconds: 0,
          degraded: true,
        };
      }
      throw new RateLimiterStoreError('Rate limiter Redis client is closed');
    }

    const now = Date.now();
    const windowIndex = Math.floor(now / this.windowMs);
    const redisKey = `${this.prefix}:${key}:${windowIndex}`;
    const windowStartMs = windowIndex * this.windowMs;
    const resetTimeMs = windowStartMs + this.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetTimeMs - now) / 1000));

    try {
      await this.ensureConnected();

      let current: number;
      if (typeof this.client.eval === 'function') {
        const luaScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;
        const res = await this.client.eval(luaScript, {
          keys: [redisKey],
          arguments: [String(this.windowMs * 2)],
        });
        current = Number(res);
      } else {
        current = await this.client.incr(redisKey);
        if (current === 1) {
          await this.client.pExpire(redisKey, this.windowMs * 2);
        }
      }

      const allowed = current <= this.maxRequests;
      const remaining = Math.max(0, this.maxRequests - current);

      return {
        allowed,
        limit: this.maxRequests,
        remaining,
        resetTimeMs,
        retryAfterSeconds,
      };
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err);
      this.logger.error({ error: sanitized, key, prefix: this.prefix }, 'Redis rate limit check failed');

      if (this.failureMode === 'fail-open') {
        return {
          allowed: true,
          limit: this.maxRequests,
          remaining: this.maxRequests,
          resetTimeMs,
          retryAfterSeconds: 0,
          degraded: true,
        };
      }

      throw new RateLimiterStoreError(sanitized);
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    if (this.connectingPromise) {
      try {
        await this.connectingPromise;
      } catch {
        // Ignored during shutdown
      }
    }

    try {
      if (this.client.isOpen) {
        if (typeof this.client.quit === 'function') {
          await this.client.quit();
        } else if (typeof this.client.disconnect === 'function') {
          await this.client.disconnect();
        }
      }
    } catch (err) {
      this.logger.warn({ error: sanitizeErrorMessage(err) }, 'Error disconnecting rate limiter Redis client');
    }
  }
}

export interface RateLimitMiddlewareOptions {
  rateLimiter: RateLimiter;
  skipPaths?: string[];
  onRateLimited?: (request: FastifyRequest) => void;
}

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  const { rateLimiter, skipPaths = ['/health'], onRateLimited } = options;

  return async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    const route = request.routeOptions?.url || request.url;
    if (skipPaths.includes(request.url) || (route && skipPaths.includes(route))) {
      return;
    }

    // Tenant isolation: use tenantId from authenticated identity, fallback to IP if unauthenticated
    const identity = request.user?.tenantId || (request.ip ?? 'anonymous');

    try {
      const result = await rateLimiter.check(identity);

      reply.header('X-RateLimit-Limit', result.limit);
      reply.header('X-RateLimit-Remaining', result.remaining);
      reply.header('X-RateLimit-Reset', Math.ceil(result.resetTimeMs / 1000));

      if (result.degraded) {
        reply.header('X-RateLimit-Degraded', 'true');
      }

      if (!result.allowed) {
        onRateLimited?.(request);
        reply.header('Retry-After', result.retryAfterSeconds);
        return reply.code(429).send({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
        });
      }
    } catch (err) {
      if (err instanceof RateLimiterStoreError) {
        request.log.error({ error: sanitizeErrorMessage(err.message), identity }, 'Rate limiter store error');
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Rate limiter error: Unable to verify rate limit due to store failure',
          code: 'RATE_LIMIT_ERROR',
        });
      }
      throw err;
    }
  };
}
