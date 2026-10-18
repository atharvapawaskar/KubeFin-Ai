import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  createMetricsRegistry,
  createMetricsServer,
  createUsageEventCounter,
  createUsageEventProcessingDuration,
  createUsageStreamLagGauge,
} from '../src/metrics.js';

test('registers bounded-label counters for usage event outcomes', async () => {
  const registry = createMetricsRegistry();
  const events = createUsageEventCounter(registry);
  events.inc({ outcome: 'inserted' });
  events.inc({ outcome: 'dead_lettered' });
  events.inc({ outcome: 'unpriced' });
  const body = await registry.metrics();
  assert.match(body, /worker_usage_events_total\{outcome="inserted"\} 1/);
  assert.match(body, /worker_usage_events_total\{outcome="dead_lettered"\} 1/);
  assert.match(body, /worker_usage_events_total\{outcome="unpriced"\} 1/);
});

test('exports bounded-cardinality processing duration and consumer group lag metrics', async () => {
  const registry = createMetricsRegistry();
  createUsageEventProcessingDuration(registry).observe(0.25);
  createUsageStreamLagGauge(registry).set(12);
  const body = await registry.metrics();
  assert.match(body, /worker_usage_event_processing_duration_seconds_bucket\{le="0.5"\} 1/);
  assert.match(body, /worker_usage_stream_lag_messages 12/);
  const workerMetrics = body.split('\n').filter((line) => line.startsWith('worker_')).join('\n');
  assert.doesNotMatch(workerMetrics, /tenantId|workloadId|model|provider/);
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
