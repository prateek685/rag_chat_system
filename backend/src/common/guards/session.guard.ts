import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { RedisService } from '../../modules/redis/redis.service';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Redis TTL for the session-exists cache key.
 * Avoids a DB upsert on every request — cache is refreshed once per 5-minute window.
 */
const SESSION_EXISTS_TTL_SECONDS = 300;

/**
 * Applied globally via APP_GUARD.
 * Validates the `x-session-id` header, upserts the session row (Redis-cached to avoid
 * per-request DB writes), and attaches `request.sessionId` for downstream handlers.
 * Routes decorated with @Public() bypass the guard entirely.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { sessionId: string }>();
    const sessionId = request.headers['x-session-id'];

    if (!sessionId || typeof sessionId !== 'string') {
      throw new BadRequestException('Missing required header: x-session-id');
    }

    if (!UUID_V4_REGEX.test(sessionId)) {
      throw new BadRequestException('x-session-id must be a valid UUIDv4');
    }

    // Cache session existence to avoid a DB upsert on every request.
    // On cache miss, upsert once and set TTL — subsequent requests skip the DB entirely.
    const cacheKey = `session:exists:${sessionId}`;
    const cached = await this.redis.client.get(cacheKey);

    if (!cached) {
      await this.prisma.session.upsert({
        where: { id: sessionId },
        create: { id: sessionId },
        update: {},
      });
      await this.redis.client.setex(cacheKey, SESSION_EXISTS_TTL_SECONDS, '1');
    }

    request.sessionId = sessionId;
    return true;
  }
}
