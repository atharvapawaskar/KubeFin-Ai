import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

export function createUsageEventCounter(registry: Registry): Counter<'outcome'> {
  return new Counter({
    name: 'worker_usage_events_total',
    help: 'Usage event delivery outcomes processed by the Worker.',
    labelNames: ['outcome'],
    registers: [registry],
  });
}

export function createUsageEventProcessingDuration(registry: Registry): Histogram {
  return new Histogram({
    name: 'worker_usage_event_processing_duration_seconds',
    help: 'Time spent processing one usage event, including persistence and acknowledgement.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
}

export function createUsageStreamLagGauge(registry: Registry): Gauge {
  return new Gauge({
    name: 'worker_usage_stream_lag_messages',
    help: 'Redis stream entries not yet delivered to the Worker consumer group.',
    registers: [registry],
  });
}

export function createMetricsServer(registry: Registry): Server {
  return createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await registry.metrics();
      response.writeHead(200, { 'content-type': registry.contentType }).end(body);
    } catch {
      response.writeHead(500).end();
    }
  });
}
