import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function allocateDistinctPorts(): Promise<[number, number]> {
  const appServer = createServer();
  const metricsServer = createServer();

  appServer.listen(0, '127.0.0.1');
  metricsServer.listen(0, '127.0.0.1');
  await Promise.all([once(appServer, 'listening'), once(metricsServer, 'listening')]);

  const appAddress = appServer.address();
  const metricsAddress = metricsServer.address();
  assert.ok(appAddress && typeof appAddress !== 'string');
  assert.ok(metricsAddress && typeof metricsAddress !== 'string');

  const appPort = appAddress.port;
  const metricsPort = metricsAddress.port;
  assert.notEqual(appPort, metricsPort);

  appServer.close();
  metricsServer.close();
  await Promise.all([once(appServer, 'close'), once(metricsServer, 'close')]);
  return [appPort, metricsPort];
}

test('starts unready without dependencies and exits cleanly on SIGTERM', async () => {
  const [appPort, metricsPort] = await allocateDistinctPorts();
  const entrypoint = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      METRICS_PORT: String(metricsPort),
      MONGODB_URI: 'mongodb://127.0.0.1:1/kubefin',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.stdout.on('data', () => {
          if (stdout.includes('Worker foundation started')) resolve();
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Worker exited before startup (${code})`)));
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Worker startup timed out')), 5_000).unref();
      }),
    ]);

    const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
    assert.equal(health.status, 200);
    const readiness = await fetch(`http://127.0.0.1:${appPort}/readyz`);
    assert.equal(readiness.status, 503);

    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.match(stdout, /Worker shutdown complete/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});
