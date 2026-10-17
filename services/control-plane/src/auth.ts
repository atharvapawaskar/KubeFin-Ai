import { createPublicKey, createVerify, type JsonWebKey as NodeJsonWebKey, type KeyObject } from 'node:crypto';

export interface Principal {
  subject: string;
  tenantIds: readonly string[];
}

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal | null>;
}

export class AuthenticationUnavailableError extends Error {}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  crit?: unknown;
  b64?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  [claim: string]: unknown;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface CachedKeySet {
  expiresAt: number;
  keys: Map<string, { alg: 'RS256' | 'ES256'; key: KeyObject }>;
}

function decodeJsonSegment<T>(segment: string): T {
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.length > 16_384) throw new Error('JWT segment is too large.');
  return JSON.parse(bytes.toString('utf8')) as T;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('JWKS response is too large.');
  if (!response.body) throw new Error('JWKS response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('JWKS response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface OidcAuthenticatorOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  tenantClaim: string;
  cacheTtlMs?: number;
  clockSkewSeconds?: number;
}

/** Verifies RS256/ES256 bearer JWTs against a configured HTTPS OIDC JWKS endpoint. */
export class OidcAuthenticator implements Authenticator {
  private keySet: CachedKeySet | undefined;
  private refreshPromise: Promise<CachedKeySet> | undefined;
  private lastRefreshAt = 0;

  constructor(private readonly options: OidcAuthenticatorOptions) {
    const jwks = new URL(options.jwksUrl);
    if (jwks.protocol !== 'https:') throw new Error('JWT JWKS URL must use HTTPS.');
    if (!options.issuer || !options.audience || !options.tenantClaim) throw new Error('JWT issuer, audience, and tenant claim are required.');
  }

  async authenticate(authorization: string | undefined): Promise<Principal | null> {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 16_384) return null;
    const token = authorization.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;

    try {
      const header = decodeJsonSegment<JwtHeader>(parts[0]!);
      const claims = decodeJsonSegment<JwtClaims>(parts[1]!);
      if ((header.alg !== 'RS256' && header.alg !== 'ES256') || header.crit !== undefined || header.b64 === false
          || typeof header.kid !== 'string' || header.kid.length < 1 || header.kid.length > 256) return null;
      const alg = header.alg;
      let keySet: CachedKeySet;
      try {
        keySet = await this.getKeySet(false);
      } catch {
        throw new AuthenticationUnavailableError('JWT signing keys are unavailable.');
      }
      let key = keySet.keys.get(header.kid);
      if (!key) {
        try {
          keySet = await this.getKeySet(true);
        } catch {
          throw new AuthenticationUnavailableError('JWT signing keys are unavailable.');
        }
        key = keySet.keys.get(header.kid);
      }
      if (!key || key.alg !== alg) return null;

      const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
      const signature = Buffer.from(parts[2]!, 'base64url');
      const verifier = createVerify(alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
      verifier.update(signed);
      verifier.end();
      const validSignature = alg === 'ES256'
        ? verifier.verify({ key: key.key, dsaEncoding: 'ieee-p1363' }, signature)
        : verifier.verify(key.key, signature);
      if (!validSignature || !this.validClaims(claims)) return null;

      const rawTenants = claims[this.options.tenantClaim];
      const tenantValues = typeof rawTenants === 'string' ? [rawTenants] : rawTenants;
      if (!Array.isArray(tenantValues) || tenantValues.length > 1000 || tenantValues.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 256)) return null;
      const tenantIds = [...new Set(tenantValues as string[])];
      if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 512 || tenantIds.length === 0) return null;
      return { subject: claims.sub, tenantIds };
    } catch (error) {
      if (error instanceof AuthenticationUnavailableError) throw error;
      return null;
    }
  }

  private validClaims(claims: JwtClaims): boolean {
    const now = Math.floor(Date.now() / 1000);
    const skew = this.options.clockSkewSeconds ?? 30;
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    return claims.iss === this.options.issuer
      && Array.isArray(audiences)
      && audiences.includes(this.options.audience)
      && typeof claims.exp === 'number'
      && Number.isFinite(claims.exp)
      && claims.exp > now - skew
      && (claims.nbf === undefined || (typeof claims.nbf === 'number' && Number.isFinite(claims.nbf) && claims.nbf <= now + skew))
      && (claims.iat === undefined || (typeof claims.iat === 'number' && Number.isFinite(claims.iat) && claims.iat <= now + skew));
  }

  private async getKeySet(force: boolean): Promise<CachedKeySet> {
    const now = Date.now();
    if (!force && this.keySet && this.keySet.expiresAt > now) return this.keySet;
    if (force && this.keySet && now - this.lastRefreshAt < 5_000) return this.keySet;
    if (this.refreshPromise) return this.refreshPromise;
    this.lastRefreshAt = now;
    this.refreshPromise = this.fetchKeySet();
    try {
      this.keySet = await this.refreshPromise;
      return this.keySet;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async fetchKeySet(): Promise<CachedKeySet> {
    const response = await fetch(this.options.jwksUrl, { signal: AbortSignal.timeout(2_500), redirect: 'error' });
    if (!response.ok) throw new Error(`JWKS request returned HTTP ${response.status}.`);
    const body = await readBoundedBody(response, 1_048_576);
    const parsed = JSON.parse(body) as { keys?: unknown };
    if (!Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 100) throw new Error('JWKS key set is invalid.');
    const keys = new Map<string, { alg: 'RS256' | 'ES256'; key: KeyObject }>();
    for (const candidate of parsed.keys as Jwk[]) {
      if (typeof candidate.kid !== 'string' || (candidate.use && candidate.use !== 'sig') || (candidate.key_ops && !candidate.key_ops.includes('verify'))) continue;
      const inferredAlg = candidate.kty === 'RSA' ? 'RS256' : candidate.kty === 'EC' && candidate.crv === 'P-256' ? 'ES256' : undefined;
      const alg = candidate.alg ?? inferredAlg;
      if (alg !== 'RS256' && alg !== 'ES256') continue;
      try {
        const publicKey = createPublicKey({ key: candidate as unknown as NodeJsonWebKey, format: 'jwk' });
        if (alg === 'RS256' && (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)) continue;
        if (alg === 'ES256' && (publicKey.asymmetricKeyType !== 'ec' || candidate.crv !== 'P-256')) continue;
        if (keys.has(candidate.kid)) throw new Error('Duplicate JWKS key id.');
        keys.set(candidate.kid, { alg, key: publicKey });
      } catch (error) {
        if (error instanceof Error && error.message === 'Duplicate JWKS key id.') throw error;
      }
    }
    if (keys.size === 0) throw new Error('JWKS contains no supported public signing keys.');
    return { keys, expiresAt: Date.now() + (this.options.cacheTtlMs ?? 300_000) };
  }
}
