export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  enabled?: boolean;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxProbes?: number;
  now?: () => number;
}

export interface CircuitBreakerPermit {
  allowed: boolean;
  isProbe: boolean;
  state: CircuitBreakerState;
  epoch?: number;
  completed?: boolean;
  reason?: string;
  release?: () => void;
}

export interface CircuitBreakerStats {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  activeProbes: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxProbes: number;
  epoch: number;
}

/**
 * Circuit Breaker state machine (CLOSED -> OPEN -> HALF_OPEN -> CLOSED / OPEN)
 * Protects downstream systems from cascading failures during upstream provider outages.
 */
export class CircuitBreaker {
  readonly enabled: boolean;
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxProbes: number;

  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private activeProbes = 0;
  private epoch = 0;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.enabled = options.enabled !== false;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1;
    this.now = options.now ?? (() => Date.now());

    if (this.failureThreshold <= 0) {
      throw new Error('CircuitBreaker failureThreshold must be a positive integer');
    }
    if (this.resetTimeoutMs <= 0) {
      throw new Error('CircuitBreaker resetTimeoutMs must be a positive integer');
    }
    if (this.halfOpenMaxProbes <= 0) {
      throw new Error('CircuitBreaker halfOpenMaxProbes must be a positive integer');
    }
  }

  /**
   * Returns current state, auto-evaluating cooldown transitions from OPEN -> HALF_OPEN.
   */
  getState(): CircuitBreakerState {
    if (!this.enabled) {
      return 'CLOSED';
    }

    if (this.state === 'OPEN' && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.activeProbes = 0;
        this.epoch++;
      }
    }

    return this.state;
  }

  /**
   * Attempts to acquire a permit to execute an upstream call.
   */
  acquirePermit(): CircuitBreakerPermit {
    if (!this.enabled) {
      return { allowed: true, isProbe: false, state: 'CLOSED', epoch: this.epoch, completed: false };
    }

    const currentState = this.getState();

    if (currentState === 'CLOSED') {
      const permit: CircuitBreakerPermit = {
        allowed: true,
        isProbe: false,
        state: 'CLOSED',
        epoch: this.epoch,
        completed: false,
      };
      permit.release = () => {
        permit.completed = true;
      };
      return permit;
    }

    if (currentState === 'OPEN') {
      return {
        allowed: false,
        isProbe: false,
        state: 'OPEN',
        epoch: this.epoch,
        completed: true,
        reason: 'Circuit is OPEN. Fast-failing upstream request.',
      };
    }

    // HALF_OPEN state: allow up to halfOpenMaxProbes concurrent probes
    if (this.activeProbes < this.halfOpenMaxProbes) {
      this.activeProbes++;
      const currentEpoch = this.epoch;
      const permit: CircuitBreakerPermit = {
        allowed: true,
        isProbe: true,
        state: 'HALF_OPEN',
        epoch: currentEpoch,
        completed: false,
      };
      permit.release = () => {
        if (!permit.completed) {
          permit.completed = true;
          if (this.state === 'HALF_OPEN' && this.epoch === currentEpoch) {
            this.activeProbes = Math.max(0, this.activeProbes - 1);
          }
        }
      };
      return permit;
    }

    return {
      allowed: false,
      isProbe: false,
      state: 'HALF_OPEN',
      epoch: this.epoch,
      completed: true,
      reason: 'Probes saturated in HALF_OPEN state. Fast-failing concurrent request.',
    };
  }

  /**
   * Records a successful upstream execution.
   */
  recordSuccess(permit?: CircuitBreakerPermit): void {
    if (!this.enabled) return;

    if (permit) {
      if (permit.completed) return;
      permit.completed = true;
      // Stale check: permit from an earlier state transition cannot alter new circuit state
      if (permit.epoch !== undefined && permit.epoch !== this.epoch) {
        return;
      }
    }

    const currentState = this.getState();

    if (permit?.isProbe) {
      // Successful probe in HALF_OPEN: fully recover and close the circuit
      this.state = 'CLOSED';
      this.consecutiveFailures = 0;
      this.openedAt = null;
      this.activeProbes = 0;
      this.epoch++;
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Records an upstream failure.
   */
  recordFailure(permit?: CircuitBreakerPermit, _error?: unknown): void {
    if (!this.enabled) return;

    if (permit) {
      if (permit.completed) return;
      permit.completed = true;
      // Stale check: permit from an earlier state transition cannot alter new circuit state
      if (permit.epoch !== undefined && permit.epoch !== this.epoch) {
        return;
      }
    }

    const currentState = this.getState();

    if (permit?.isProbe || currentState === 'HALF_OPEN') {
      // Failed probe in HALF_OPEN: immediately re-open circuit for another cooldown period
      this.state = 'OPEN';
      this.openedAt = this.now();
      this.activeProbes = 0;
      this.consecutiveFailures++;
      this.epoch++;
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = 'OPEN';
        this.openedAt = this.now();
        this.activeProbes = 0;
        this.epoch++;
      }
    }
  }

  /**
   * Returns a snapshot of internal stats.
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      activeProbes: this.activeProbes,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      halfOpenMaxProbes: this.halfOpenMaxProbes,
      epoch: this.epoch,
    };
  }

  /**
   * Forcefully opens the circuit breaker.
   */
  forceOpen(): void {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.activeProbes = 0;
    this.epoch++;
  }

  /**
   * Forcefully closes the circuit breaker and clears failure counters.
   */
  forceClose(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.activeProbes = 0;
    this.epoch++;
  }

  /**
   * Resets the circuit breaker to its initial CLOSED state.
   */
  reset(): void {
    this.forceClose();
  }
}
