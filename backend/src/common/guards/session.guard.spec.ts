import { BadRequestException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { SessionGuard } from './session.guard';

const VALID_UUID = 'a3bb189e-8bf9-4f12-b123-ab3b9f2b2ded';

function mockContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('SessionGuard', () => {
  let guard: SessionGuard;
  const mockReflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
  const mockPrisma = {
    session: {
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const mockRedis = {
    client: {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockReflector.getAllAndOverride.mockReturnValue(false);
    guard = new SessionGuard(mockReflector as any, mockPrisma as any, mockRedis as any);
  });

  it('throws 400 when x-session-id header is absent', async () => {
    const ctx = mockContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(BadRequestException);
  });

  it('throws 400 when x-session-id is not a valid UUIDv4', async () => {
    const ctx = mockContext({ 'x-session-id': 'not-a-uuid' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(BadRequestException);
  });

  it('throws 400 for a v1 UUID (wrong version bit)', async () => {
    // v1 UUID — version nibble is "1", not "4"
    const ctx = mockContext({ 'x-session-id': 'a3bb189e-8bf9-1f12-b123-ab3b9f2b2ded' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(BadRequestException);
  });

  it('upserts the session and attaches sessionId to request for a valid UUIDv4', async () => {
    const request: any = { headers: { 'x-session-id': VALID_UUID } };
    const ctx = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(mockPrisma.session.upsert).toHaveBeenCalledWith({
      where: { id: VALID_UUID },
      create: { id: VALID_UUID },
      update: {},
    });
    expect(mockRedis.client.setex).toHaveBeenCalledWith(
      `session:exists:${VALID_UUID}`,
      300,
      '1',
    );
    expect(request.sessionId).toBe(VALID_UUID);
  });
});
