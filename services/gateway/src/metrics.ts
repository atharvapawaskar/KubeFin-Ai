import type { FastifyRequest } from 'fastify';

/**
 * Formats a Prometheus metric line with escaped labels and deterministic sorting.
 */
export function formatMetricLine(
  metricName: string,
  labels: Record<string, string | number>,
  value: number | string
): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return `${metricName} ${value}`;
  }
  const labelParts = keys.map(
    (k) =>
      `${k}="${String(labels[k])
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')}"`
  );
  return `${metricName}{${labelParts.join(',')}} ${value}`;
}

export function formatPrometheusLabels(labels?: Record<string, string>): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const labelParts = keys.map(
    (k) =>
      `${k}="${labels[k]
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')}"`
  );
  return `{${labelParts.join(',')}}`;
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Record<string, string> = {}, amount = 1): void {
    if (amount < 0) {
      throw new Error('Counter cannot be incremented by negative value');
    }
    const key = formatPrometheusLabels(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(key, { labels, value: amount });
    }
  }

  get(labels: Record<string, string> = {}): number {
    const key = formatPrometheusLabels(labels);
    return this.values.get(key)?.value || 0;
  }

  reset(): void {
    this.values.clear();
  }

  toPrometheusText(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];

    if (this.values.size === 0) {
      return lines.join('\n');
    }

    for (const { labels, value } of this.values.values()) {
      lines.push(formatMetricLine(this.name, labels, value));
    }

    return lines.join('\n');
  }
}

export interface HistogramOptions {
  name: string;
  help: string;
  buckets?: number[];
}

interface HistogramEntry {
  labels: Record<string, string>;
  bucketCounts: number[];
  sum: number;
  count: number;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  private readonly entries = new Map<string, HistogramEntry>();

  constructor(options: HistogramOptions) {
    this.name = options.name;
    this.help = options.help;
    this.buckets = (
      options.buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
    ).slice().sort((a, b) => a - b);
  }

  observe(labels: Record<string, string>, value: number): void {
    if (value < 0) return;
    const key = formatPrometheusLabels(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        labels,
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.entries.set(key, entry);
    }

    entry.sum += value;
    entry.count += 1;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i] += 1;
      }
    }
  }

  get(labels: Record<string, string> = {}): { count: number; sum: number } | undefined {
    const key = formatPrometheusLabels(labels);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { count: entry.count, sum: entry.sum };
  }

  reset(): void {
    this.entries.clear();
  }

  toPrometheusText(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    if (this.entries.size === 0) {
      return lines.join('\n');
    }

    for (const entry of this.entries.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          formatMetricLine(
            `${this.name}_bucket`,
            { ...entry.labels, le: String(this.buckets[i]) },
            entry.bucketCounts[i]
          )
        );
      }
      lines.push(
        formatMetricLine(
          `${this.name}_bucket`,
          { ...entry.labels, le: '+Inf' },
          entry.count
        )
      );
      lines.push(
        formatMetricLine(
          `${this.name}_sum`,
          entry.labels,
          entry.sum
        )
      );
      lines.push(
        formatMetricLine(
          `${this.name}_count`,
          entry.labels,
          entry.count
        )
      );
    }

    return lines.join('\n');
  }
}

/**
 * Central metrics registry for Kubefin Gateway.
 */
export class MetricsRegistry {
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDurationSeconds: Histogram;
  readonly providerRequestsTotal: Counter;
  readonly providerErrorsTotal: Counter;
  readonly rateLimitRejectionsTotal: Counter;

  constructor() {
    this.httpRequestsTotal = new Counter(
      'gateway_http_requests_total',
      'Total number of HTTP requests processed by Gateway'
    );
    this.httpRequestDurationSeconds = new Histogram({
      name: 'gateway_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    });
    this.providerRequestsTotal = new Counter(
      'gateway_provider_requests_total',
      'Total number of upstream AI provider requests'
    );
    this.providerErrorsTotal = new Counter(
      'gateway_provider_errors_total',
      'Total number of upstream AI provider errors by type'
    );
    this.rateLimitRejectionsTotal = new Counter(
      'gateway_rate_limit_rejections_total',
      'Total number of requests rejected by Gateway rate limiting'
    );
  }

  reset(): void {
    this.httpRequestsTotal.reset();
    this.httpRequestDurationSeconds.reset();
    this.providerRequestsTotal.reset();
    this.providerErrorsTotal.reset();
    this.rateLimitRejectionsTotal.reset();
  }

  toPrometheusText(): string {
    const parts = [
      this.httpRequestsTotal.toPrometheusText(),
      this.httpRequestDurationSeconds.toPrometheusText(),
      this.providerRequestsTotal.toPrometheusText(),
      this.providerErrorsTotal.toPrometheusText(),
      this.rateLimitRejectionsTotal.toPrometheusText(),
    ];
    return parts.join('\n\n') + '\n';
  }
}

/**
 * Normalizes request route to prevent cardinality explosion from unmatched/random paths.
 */
export function normalizeRoute(request: FastifyRequest): string {
  const matched = request.routeOptions?.url;
  if (!matched || matched === '/*') {
    return 'unmatched';
  }
  return matched;
}
