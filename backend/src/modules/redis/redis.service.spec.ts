import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from './redis.service';

const mockRedisInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue('OK'),
};

// __esModule: true is required because ioredis uses a default export and
// tsconfig has esModuleInterop: true — without it Jest's CJS transform
// may not intercept the `new Redis()` constructor call correctly.
jest.mock('ioredis', () => ({
  default: jest.fn().mockImplementation(() => mockRedisInstance),
  __esModule: true,
}));

describe('RedisService', () => {
  let service: RedisService;

  const mockConfigService = {
    getOrThrow: jest.fn().mockReturnValue('localhost'),
    get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'REDIS_PORT') return 6379;
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should expose a client instance', () => {
    expect(service.client).toBeDefined();
  });

  it('should read REDIS_HOST via getOrThrow', () => {
    expect(mockConfigService.getOrThrow).toHaveBeenCalledWith('REDIS_HOST');
  });

  it('should read REDIS_PORT with default 6379', () => {
    expect(mockConfigService.get).toHaveBeenCalledWith('REDIS_PORT', 6379);
  });

  describe('onModuleInit', () => {
    it('should call client.connect()', async () => {
      await service.onModuleInit();
      expect(mockRedisInstance.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleDestroy', () => {
    it('should call client.quit()', async () => {
      await service.onModuleDestroy();
      expect(mockRedisInstance.quit).toHaveBeenCalledTimes(1);
    });
  });
});
