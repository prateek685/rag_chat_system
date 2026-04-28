import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

// Mock the adapter so no real DB connection is attempted.
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({ provider: 'postgresql', adapterName: 'mock' })),
}));

// Mock PrismaClient as a proper class so that PrismaService's prototype methods
// (onModuleInit, onModuleDestroy) are preserved on the derived instance.
// Using jest.fn().mockImplementation(() => plainObject) would replace `this`
// with the returned object, stripping the subclass prototype.
jest.mock('@prisma/client', () => {
  class MockPrismaClient {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
  }
  return { PrismaClient: MockPrismaClient };
});

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'DATABASE_URL') return 'postgresql://test:test@localhost:5432/test';
              throw new Error(`Unexpected config key: ${key}`);
            },
          },
        },
      ],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should call $connect', async () => {
      const connectSpy = jest.spyOn(service as any, '$connect').mockResolvedValueOnce(undefined);
      await service.onModuleInit();
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleDestroy', () => {
    it('should call $disconnect', async () => {
      const disconnectSpy = jest.spyOn(service as any, '$disconnect').mockResolvedValueOnce(undefined);
      await service.onModuleDestroy();
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });
  });
});
