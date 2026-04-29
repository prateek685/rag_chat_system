import { envValidationSchema } from './env.config';

/** Minimal set of env vars that passes every required() constraint. */
const VALID_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_HOST: 'localhost',
  OPENROUTER_API_KEY: 'sk-test-key',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_HOST: 'http://localhost:3000',
};

function validate(overrides: Record<string, unknown> = {}) {
  return envValidationSchema.validate({ ...VALID_ENV, ...overrides }, { abortEarly: false });
}

describe('envValidationSchema', () => {
  describe('required fields', () => {
    it.each([
      'DATABASE_URL',
      'REDIS_HOST',
      'OPENROUTER_API_KEY',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
      'LANGFUSE_HOST',
    ])('rejects when %s is missing', (key) => {
      const env = { ...VALID_ENV } as Record<string, unknown>;
      delete env[key];
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    });

    it('passes validation when all required fields are present', () => {
      const { error } = validate();
      expect(error).toBeUndefined();
    });
  });

  describe('default values', () => {
    it('defaults NODE_ENV to "development"', () => {
      const { value } = validate();
      expect(value.NODE_ENV).toBe('development');
    });

    it('defaults PORT to 8080', () => {
      const { value } = validate();
      expect(value.PORT).toBe(8080);
    });

    it('defaults REDIS_PORT to 6379', () => {
      const { value } = validate();
      expect(value.REDIS_PORT).toBe(6379);
    });

    it('defaults FRONTEND_URL to "http://localhost:3001"', () => {
      const { value } = validate();
      expect(value.FRONTEND_URL).toBe('http://localhost:3001');
    });

    it('defaults EMBEDDING_DIMENSIONS to 2048', () => {
      const { value } = validate();
      expect(value.EMBEDDING_DIMENSIONS).toBe(2048);
    });
  });

  describe('NODE_ENV', () => {
    it.each(['development', 'production', 'test'])(
      'accepts "%s"',
      (env) => {
        const { error } = validate({ NODE_ENV: env });
        expect(error).toBeUndefined();
      },
    );

    it('rejects an unknown NODE_ENV value', () => {
      const { error } = validate({ NODE_ENV: 'staging' });
      expect(error).toBeDefined();
    });
  });

  describe('LANGFUSE_HOST', () => {
    it('rejects a non-URI string', () => {
      const { error } = validate({ LANGFUSE_HOST: 'not-a-url' });
      expect(error).toBeDefined();
      expect(error!.message).toContain('LANGFUSE_HOST');
    });

    it('accepts a valid http URI', () => {
      const { error } = validate({ LANGFUSE_HOST: 'http://langfuse.internal' });
      expect(error).toBeUndefined();
    });

    it('accepts a valid https URI', () => {
      const { error } = validate({ LANGFUSE_HOST: 'https://cloud.langfuse.com' });
      expect(error).toBeUndefined();
    });
  });

  describe('FRONTEND_URL', () => {
    it('rejects a non-URI string', () => {
      const { error } = validate({ FRONTEND_URL: 'not-a-url' });
      expect(error).toBeDefined();
    });

    it('accepts a custom valid URI', () => {
      const { error } = validate({ FRONTEND_URL: 'http://app.example.com' });
      expect(error).toBeUndefined();
    });
  });

  describe('EMBEDDING_DIMENSIONS', () => {
    it('rejects a value below the minimum (64)', () => {
      const { error } = validate({ EMBEDDING_DIMENSIONS: 32 });
      expect(error).toBeDefined();
    });

    it('rejects a value above the maximum (8192)', () => {
      const { error } = validate({ EMBEDDING_DIMENSIONS: 9000 });
      expect(error).toBeDefined();
    });

    it('accepts a value within range', () => {
      const { error } = validate({ EMBEDDING_DIMENSIONS: 1536 });
      expect(error).toBeUndefined();
    });

    it('rejects a non-integer value', () => {
      const { error } = validate({ EMBEDDING_DIMENSIONS: 1536.5 });
      expect(error).toBeDefined();
    });
  });

  describe('UPLOADS_PATH', () => {
    it('is optional — passes when omitted', () => {
      const { error } = validate();
      expect(error).toBeUndefined();
    });

    it('accepts a string value when provided', () => {
      const { error } = validate({ UPLOADS_PATH: '/app/uploads' });
      expect(error).toBeUndefined();
    });
  });
});
