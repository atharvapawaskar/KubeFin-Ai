import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthApp } from '../src/app.js';

test('liveness responds without checking dependencies', async () => {
  let checks = 0;
  const app = buildHealthApp({
    nodeEnv: 'test',
    checkReady: async () => {
      checks += 1;
      throw new Error('dependency unavailable');
    },
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.equal(checks, 0);
  } finally {
    await app.close();
  }
});

test('readiness is 200 when dependencies are ready and 503 otherwise', async () => {
  let ready = true;
  const app = buildHealthApp({
    nodeEnv: 'test',
    checkReady: async () => {
      if (!ready) throw new Error('dependency unavailable');
    },
  });

  try {
    const readyResponse = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(readyResponse.statusCode, 200);
    assert.deepEqual(readyResponse.json(), { status: 'ready' });

    ready = false;
    const unavailableResponse = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(unavailableResponse.statusCode, 503);
    assert.deepEqual(unavailableResponse.json(), { status: 'not_ready' });
  } finally {
    await app.close();
  }
});
