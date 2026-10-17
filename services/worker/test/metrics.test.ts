import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createMetricsRegistry, createMetricsServer, createUsageEventCounter } from '../src/metrics.js';

test('registers bounded-label counters for usage event outcomes', async () => {
  const registry = createMetricsRegistry();
  const events = createUsageEventCounter(registry);
  events.inc({ outcome: 'inserted' });
  events.inc({ outcome: 'dead_lettered' });
  const body = await registry.metrics();
  assert.match(body, /worker_usage_events_total\{outcome="inserted"\} 1/);
  assert.match(body, /worker_usage_events_total\{outcome="dead_lettered"\} 1/);
});

test('serves Prometheus metrics only from the metrics listener path', async () => {
  const server = createMetricsServer(createMetricsRegistry());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const metricsResponse = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(metricsResponse.headers.get('content-type') ?? '', /text\/plain|application\/openmetrics-text/);
    assert.match(await metricsResponse.text(), /process_cpu_seconds_total|nodejs_eventloop_lag_seconds/);

    const unknownResponse = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(unknownResponse.status, 404);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
