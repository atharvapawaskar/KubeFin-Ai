import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017/kubefin',
  JWT_ISSUER: 'https://issuer.example',
  JWT_AUDIENCE: 'kubefin-control-plane',
  JWT_JWKS_URL: 'https://issuer.example/.well-known/jwks.json',
  JWT_TENANT_CLAIM: 'authorized_tenants',
  CURSOR_SIGNING_KEY: 'c'.repeat(32),
};

test('requires secure authentication and cursor signing configuration', () => {
  const config = parseConfig(valid);
  assert.equal(config.port, 4000);
  assert.equal(config.jwtTenantClaim, 'authorized_tenants');
  assert.throws(() => parseConfig({ ...valid, JWT_JWKS_URL: 'http://issuer.example/jwks' }), /JWT_JWKS_URL/);
  assert.throws(() => parseConfig({ ...valid, CURSOR_SIGNING_KEY: 'short' }), /CURSOR_SIGNING_KEY/);
  assert.throws(() => parseConfig({ ...valid, JWT_TENANT_CLAIM: '' }), /JWT_TENANT_CLAIM/);
});
