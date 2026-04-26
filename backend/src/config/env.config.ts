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

  // Single credential for all LLM calls. OpenRouter proxies both free and OpenAI models.
  OPENROUTER_API_KEY: Joi.string().required(),

  // Embedding model served via OpenRouter. Switch to 'openai/text-embedding-3-small'
  // to route through OpenRouter's OpenAI proxy without any code change.
  EMBEDDING_MODEL: Joi.string().default('nvidia/llama-nemotron-embed-vl-1b-v2:free'),

  // Output dimensions of EMBEDDING_MODEL. Must match the vector() column type in document_chunks.
  // nvidia/llama-nemotron-embed-vl-1b-v2:free → verify before first run.
  // openai/text-embedding-3-small → 1536.
  EMBEDDING_DIMENSIONS: Joi.number().integer().min(64).max(8192).default(2048),

  // Generation model (M3 — not yet implemented). Switch to 'openai/gpt-4o' for OpenAI.
  GENERATOR_MODEL: Joi.string().default('deepseek/deepseek-r1:free'),

  // Routing/classification model. Switch to 'openai/gpt-4o-mini' for highest reliability.
  ROUTER_MODEL: Joi.string().default('google/gemma-3-4b-it:free'),

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
  OPENROUTER_API_KEY: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: number;
  GENERATOR_MODEL: string;
  ROUTER_MODEL: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_HOST: string;
  FRONTEND_URL: string;
}
