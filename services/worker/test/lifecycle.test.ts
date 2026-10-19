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

async function startWorkerWithRetries(
  entrypoint: string,
  maxAttempts = 3,
): Promise<{
  child: ReturnType<typeof spawn>;
  stdout: { value: string };
  stderr: { value: string };
}> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [appPort, metricsPort] = await allocateDistinctPorts();
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

    const stdout = { value: '' };
    const stderr = { value: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.value += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.value += chunk.toString();
    });

    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.stdout.on('data', () => {
            if (stdout.value.includes('Worker foundation started')) resolve();
          });
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error(`Worker exited before startup (${code})`)));
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Worker startup timed out')), 5_000).unref();
        }),
      ]);
      return { child, stdout, stderr };
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (attempt === maxAttempts) {
        const detail = `${String(error)}\nstderr: ${stderr.value}\nstdout: ${stdout.value}`;
        throw new Error(detail);
      }
    }
  }
  throw new Error('Worker failed to start after retries');
}

test('starts unready without dependencies and exits cleanly on SIGTERM', async () => {
  const entrypoint = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const { child, stdout } = await startWorkerWithRetries(entrypoint);
  const portMatch = stdout.value.match(/"port":(\d+)/);
  assert.ok(portMatch, `Missing startup port in logs: ${stdout.value}`);
  const appPort = Number(portMatch[1]);

  try {
    const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
    assert.equal(health.status, 200);
    const readiness = await fetch(`http://127.0.0.1:${appPort}/readyz`);
    assert.equal(readiness.status, 503);

    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.match(stdout.value, /Worker shutdown complete/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});
