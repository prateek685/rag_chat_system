import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

/**
 * Smoke tests for the global HTTP layer — error envelope shape and global filter.
 * Uses a minimal NestJS app (no real DB/Redis) so it runs in CI without infrastructure.
 */
describe('AppModule (e2e smoke)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 with a formatted ErrorResponse envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/nonexistent-route');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('statusCode', 404);
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('path', '/nonexistent-route');
    expect(res.body).toHaveProperty('traceId');
    expect(res.body).toHaveProperty('message');
  });

  it('returns 404 for a nested unknown route', async () => {
    const res = await request(app.getHttpServer()).get('/api/does/not/exist');

    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
  });

  it('includes a valid ISO-8601 timestamp in the error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/unknown');

    expect(new Date(res.body.timestamp as string).toISOString()).toBe(res.body.timestamp);
  });
});
