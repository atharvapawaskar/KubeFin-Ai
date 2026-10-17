import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Registry } from '@prometheus-io/client';

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
