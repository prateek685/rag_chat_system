import * as Joi from 'joi';

/**
 * Validates and types all environment variables at startup.
 * Access env vars only through this config — never process.env inline.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(8080),

  DATABASE_URL: Joi.string().required(),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),

  OPENAI_API_KEY: Joi.string().required(),

  LANGFUSE_PUBLIC_KEY: Joi.string().required(),
  LANGFUSE_SECRET_KEY: Joi.string().required(),
  LANGFUSE_HOST: Joi.string().uri().required(),

  NEXT_PUBLIC_API_URL: Joi.string().uri().optional(),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:3001'),
  PGADMIN_DEFAULT_EMAIL: Joi.string().email().optional(),
  PGADMIN_DEFAULT_PASSWORD: Joi.string().optional(),
});

export interface EnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  DATABASE_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  OPENAI_API_KEY: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_HOST: string;
  FRONTEND_URL: string;
}
