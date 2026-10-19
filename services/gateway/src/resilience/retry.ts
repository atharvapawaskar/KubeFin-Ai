/**
 * Determines whether an error is transient and eligible for bounded upstream retry.
 *
 * NOTE: Timeouts, aborts, and connection resets are intentionally NOT retried.
 * Google Gemini does not support request deduplication / idempotency headers;
 * retrying an in-flight request risks duplicate token consumption and double-billing.
 */
export function isTransientError(err: unknown): boolean {
  if (!err) return false;

  const errorObj = err as any;
  const name = typeof errorObj?.name === 'string' ? errorObj.name : '';
  const message = typeof errorObj?.message === 'string' ? errorObj.message.toLowerCase() : '';
  const code = typeof errorObj?.code === 'string' ? errorObj.code : '';
  const status = typeof errorObj?.status === 'number' ? errorObj.status : typeof errorObj?.statusCode === 'number' ? errorObj.statusCode : undefined;

  // 1. Timeouts and aborts: DO NOT RETRY (conservative double-billing prevention)
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'PROVIDER_TIMEOUT' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('deadline exceeded')
  ) {
    return false;
  }

  // 2. Connection resets: DO NOT RETRY (request was in flight, could be billed)
  if (code === 'ECONNRESET' || message.includes('econnreset') || message.includes('connection reset')) {
    return false;
  }

  // 3. Circuit Breaker Fast-Fail: DO NOT RETRY
  if (code === 'CIRCUIT_BREAKER_OPEN' || message.includes('circuit breaker is open')) {
    return false;
  }

  // 4. Client authentication & authorization errors: DO NOT RETRY
  if (
    status === 401 ||
    status === 403 ||
    code === 'PROVIDER_AUTH_ERROR' ||
    message.includes('unauthorized') ||
    message.includes('invalid api key') ||
    message.includes('401')
  ) {
    return false;
  }

  // 5. Client 4xx errors (except 429 Too Many Requests): DO NOT RETRY
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return false;
  }

  // 6. Explicit 429 Rate Limiting / Quota: RETRYABLE
  if (
    status === 429 ||
    code === 'PROVIDER_RATE_LIMIT' ||
    code === 'RESOURCE_EXHAUSTED' ||
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted') ||
    message.includes('quota')
  ) {
    return true;
  }

  // 7. Upstream 503 Service Unavailable / 502 Bad Gateway / 500 Internal Error: RETRYABLE
  if (
    status === 503 ||
    status === 502 ||
    status === 500 ||
    message.includes('503') ||
    message.includes('service unavailable') ||
    message.includes('502') ||
    message.includes('bad gateway') ||
    message.includes('overloaded')
  ) {
    return true;
  }

  // 8. Connection refused / host unreachable before connection established: RETRYABLE
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || message.includes('econnrefused')) {
    return true;
  }

  return false;
}

export interface RetryDelayOptions {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: boolean;
  randomFn?: () => number;
}

/**
 * Calculates exponential backoff with bounded jitter.
 * Formula: min(maxDelayMs, baseDelayMs * 2^(attempt - 1)) * (0.5 + 0.5 * random)
 */
export function calculateRetryDelay(options: RetryDelayOptions): number {
  const { attempt, baseDelayMs, maxDelayMs, jitter = true, randomFn = Math.random } = options;
  const exponent = Math.max(0, attempt - 1);
  const expDelay = baseDelayMs * Math.pow(2, exponent);
  const cappedDelay = Math.min(maxDelayMs, expDelay);

  if (!jitter) {
    return Math.max(0, Math.round(cappedDelay));
  }

  // Bounded jitter factor between 0.5 and 1.0 (prevents thundering herd)
  const factor = 0.5 + 0.5 * randomFn();
  return Math.min(maxDelayMs, Math.max(1, Math.round(cappedDelay * factor)));
}

export interface ExecuteWithRetryOptions<T> {
  fn: (attempt: number) => Promise<T>;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: boolean;
  signal?: AbortSignal;
  isTransient?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Default sleep implementation with immediate abort-signal cancellation.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return reject(err);
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Executes an async operation with bounded exponential retry for transient errors.
 */
export async function executeWithRetry<T>(options: ExecuteWithRetryOptions<T>): Promise<T> {
  const {
    fn,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    jitter = true,
    signal,
    isTransient = isTransientError,
    onRetry,
    sleep = defaultSleep,
  } = options;

  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }

    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isTransient(err) || signal?.aborted) {
        throw err;
      }

      attempt++;
      const delayMs = calculateRetryDelay({ attempt, baseDelayMs, maxDelayMs, jitter });

      if (onRetry) {
        onRetry(err, attempt, delayMs);
      }

      await sleep(delayMs, signal);
    }
  }
}
