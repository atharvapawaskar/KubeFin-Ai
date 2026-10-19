import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createAuthMiddleware } from '../src/middleware/auth.js';

describe('Authentication Middleware', () => {
  const API_KEY = 'test-api-key-12345';
  const TENANT_ID = 'test-tenant';
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Add auth middleware
    app.addHook('onRequest', createAuthMiddleware({
      apiKey: API_KEY,
      tenantId: TENANT_ID,
      skipPaths: ['/health'],
    }));

    // Public endpoint
    app.get('/health', async () => ({ status: 'ok' }));

    // Protected endpoint
    app.get('/v1/test', async (request) => ({
      authenticated: true,
      tenantId: request.user?.tenantId,
      apiKeyPrefix: request.user?.apiKeyPrefix,
    }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('should work without authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ status: 'ok' });
    });
  });

  describe('Protected endpoints', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/test',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('MISSING_AUTH_HEADER');
    });

    it('should return 401 when Authorization header has invalid format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/test',
        headers: {
          authorization: 'InvalidFormat',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('INVALID_AUTH_FORMAT');
    });

    it('should return 401 when Authorization header is not Bearer', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/test',
        headers: {
          authorization: 'Basic dXNlcjpwYXNz',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('INVALID_AUTH_FORMAT');
    });

    it('should return 401 when API key is invalid', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/test',
        headers: {
          authorization: 'Bearer wrong-api-key',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('INVALID_API_KEY');
    });

    it('should return 200 when API key is valid', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.authenticated).toBe(true);
      expect(body.tenantId).toBe(TENANT_ID);
      expect(body.apiKeyPrefix).toBe(API_KEY.slice(0, 8));
    });

    it('should attach user identity to request', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.tenantId).toBe(TENANT_ID);
      expect(body.apiKeyPrefix).toBe('test-api'); // first 8 chars
    });
  });
});