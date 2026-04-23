import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as public — SessionGuard will bypass x-session-id validation.
 * Use on controllers or individual handlers (e.g. GET /api/health, Swagger UI).
 */
export const Public = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(IS_PUBLIC_KEY, true);
