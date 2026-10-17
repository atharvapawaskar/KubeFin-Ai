import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { OidcAuthenticator } from '../src/auth.js';

function jwt(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], kid: string, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

test('verifies issuer, audience, expiry, signature, and configured tenant scope claim', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'signing-key', alg: 'RS256', use: 'sig' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const auth = new OidcAuthenticator({ issuer: 'https://issuer.example', audience: 'kubefin-api', jwksUrl: 'https://issuer.example/.well-known/jwks.json', tenantClaim: 'authorized_tenants' });
    const token = jwt(privateKey, 'signing-key', {
      iss: 'https://issuer.example', aud: ['kubefin-api'], sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60, authorized_tenants: ['tenant-a', 'tenant-b'],
    });
    assert.deepEqual(await auth.authenticate(`Bearer ${token}`), { subject: 'user-1', tenantIds: ['tenant-a', 'tenant-b'] });
    assert.equal(await auth.authenticate(`Bearer ${token.slice(0, -3)}abc`), null);
    assert.equal(await auth.authenticate('Basic no'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects expired and out-of-audience tokens', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'key-2', alg: 'RS256', use: 'sig' }] }), { status: 200 });
  try {
    const auth = new OidcAuthenticator({ issuer: 'https://issuer.example', audience: 'kubefin-api', jwksUrl: 'https://issuer.example/jwks', tenantClaim: 'tenant_id' });
    const expired = jwt(privateKey, 'key-2', { iss: 'https://issuer.example', aud: 'kubefin-api', sub: 'u', exp: 1, tenant_id: 'tenant-a' });
    const wrongAudience = jwt(privateKey, 'key-2', { iss: 'https://issuer.example', aud: 'elsewhere', sub: 'u', exp: Math.floor(Date.now() / 1000) + 60, tenant_id: 'tenant-a' });
    assert.equal(await auth.authenticate(`Bearer ${expired}`), null);
    assert.equal(await auth.authenticate(`Bearer ${wrongAudience}`), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fails closed on insecure JWKS URLs and unavailable key service', async () => {
  assert.throws(() => new OidcAuthenticator({ issuer: 'https://issuer.example', audience: 'api', jwksUrl: 'http://issuer.example/jwks', tenantClaim: 'tenant_id' }), /HTTPS/);
  const auth = new OidcAuthenticator({ issuer: 'https://issuer.example', audience: 'api', jwksUrl: 'https://issuer.example/jwks', tenantClaim: 'tenant_id' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'unknown' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'https://issuer.example', aud: 'api', sub: 'u', exp: Math.floor(Date.now() / 1000) + 60, tenant_id: 'tenant-a' })).toString('base64url');
    await assert.rejects(auth.authenticate(`Bearer ${header}.${claims}.signature`), /signing keys are unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
