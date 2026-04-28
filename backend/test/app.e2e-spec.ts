// Prevent ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG from Langfuse
jest.mock('langfuse', () => ({ __esModule: true, default: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return 404 with formatted ErrorResponse for unknown routes', () => {
    return request(app.getHttpServer())
      .get('/nonexistent-route')
      .expect(404)
      .expect((res) => {
        expect(res.body).toHaveProperty('statusCode', 404);
        expect(res.body).toHaveProperty('timestamp');
        expect(res.body).toHaveProperty('traceId');
        expect(res.body).toHaveProperty('message');
      });
  });
});
