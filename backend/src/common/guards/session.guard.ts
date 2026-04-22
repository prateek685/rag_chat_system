import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../modules/prisma/prisma.service';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Applied globally (except the health-check route).
 * Validates the `x-session-id` header and upserts the corresponding Session row
 * so every downstream handler can assume the session exists in the database.
 * The validated session ID is attached to `request.sessionId` for controller use.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { sessionId: string }>();
    const sessionId = request.headers['x-session-id'];

    if (!sessionId || typeof sessionId !== 'string') {
      throw new BadRequestException('Missing required header: x-session-id');
    }

    if (!UUID_V4_REGEX.test(sessionId)) {
      throw new BadRequestException('x-session-id must be a valid UUIDv4');
    }

    await this.prisma.session.upsert({
      where: { id: sessionId },
      create: { id: sessionId },
      update: {},
    });

    request.sessionId = sessionId;
    return true;
  }
}
