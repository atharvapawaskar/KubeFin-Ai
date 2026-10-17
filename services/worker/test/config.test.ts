import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';

const validEnvironment = {
  MONGODB_URI: 'mongodb://localhost:27017/kubefin',
  REDIS_URL: 'redis://localhost:6379',
};

test('uses the agreed service and metrics ports when not overridden', () => {
  const config = parseConfig(validEnvironment);
  assert.equal(config.PORT, 3000);
  assert.equal(config.METRICS_PORT, 9090);
});

test('rejects equal service and metrics ports', () => {
  assert.throws(() => parseConfig({ ...validEnvironment, PORT: '9090' }));
});

test('rejects missing connection strings and invalid URL schemes', () => {
  assert.throws(() => parseConfig({ MONGODB_URI: '', REDIS_URL: 'http://localhost' }));
});

test('accepts TLS Redis and MongoDB SRV connection URLs', () => {
  const config = parseConfig({
    MONGODB_URI: 'mongodb+srv://mongo.example/kubefin',
    REDIS_URL: 'rediss://redis.example:6380',
  });
  assert.equal(config.REDIS_URL, 'rediss://redis.example:6380');
});
