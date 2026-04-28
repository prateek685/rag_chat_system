import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from './redis.service';

const mockRedisInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue('OK'),
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  scan: jest.fn(),
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
    get: jest.fn().mockImplementation((key: string, _opts?: unknown) => {
      if (key === 'REDIS_HOST') return 'localhost';
      if (key === 'REDIS_PORT') return 6379;
      return undefined;
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

  it('should expose a raw client instance for BullMQ', () => {
    expect(service.client).toBeDefined();
  });

  it('should read REDIS_HOST via get', () => {
    expect(mockConfigService.get).toHaveBeenCalledWith('REDIS_HOST', { infer: true });
  });

  it('should read REDIS_PORT', () => {
    expect(mockConfigService.get).toHaveBeenCalledWith('REDIS_PORT', { infer: true });
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

  // ---------------------------------------------------------------------------
  // Typed wrapper methods
  // ---------------------------------------------------------------------------

  describe('get()', () => {
    it('returns the stored value on success', async () => {
      mockRedisInstance.get.mockResolvedValue('cached-response');
      const result = await service.get('some-key');
      expect(result).toBe('cached-response');
      expect(mockRedisInstance.get).toHaveBeenCalledWith('some-key');
    });

    it('returns null on cache miss', async () => {
      mockRedisInstance.get.mockResolvedValue(null);
      const result = await service.get('missing-key');
      expect(result).toBeNull();
    });

    it('returns null (fail-open) when Redis throws', async () => {
      mockRedisInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.get('error-key');
      expect(result).toBeNull();
    });
  });

  describe('set()', () => {
    it('calls client.set with key and value', async () => {
      mockRedisInstance.set.mockResolvedValue('OK');
      await service.set('k', 'v');
      expect(mockRedisInstance.set).toHaveBeenCalledWith('k', 'v');
    });

    it('does not throw when Redis errors', async () => {
      mockRedisInstance.set.mockRejectedValue(new Error('timeout'));
      await expect(service.set('k', 'v')).resolves.toBeUndefined();
    });
  });

  describe('setex()', () => {
    it('calls client.setex with key, ttl, and value', async () => {
      mockRedisInstance.setex.mockResolvedValue('OK');
      await service.setex('k', 3600, 'v');
      expect(mockRedisInstance.setex).toHaveBeenCalledWith('k', 3600, 'v');
    });

    it('does not throw when Redis errors', async () => {
      mockRedisInstance.setex.mockRejectedValue(new Error('timeout'));
      await expect(service.setex('k', 3600, 'v')).resolves.toBeUndefined();
    });
  });

  describe('del()', () => {
    it('calls client.del with the key', async () => {
      mockRedisInstance.del.mockResolvedValue(1);
      await service.del('k');
      expect(mockRedisInstance.del).toHaveBeenCalledWith('k');
    });

    it('does not throw when Redis errors', async () => {
      mockRedisInstance.del.mockRejectedValue(new Error('timeout'));
      await expect(service.del('k')).resolves.toBeUndefined();
    });
  });

  describe('incr()', () => {
    it('returns the incremented counter', async () => {
      mockRedisInstance.incr.mockResolvedValue(5);
      const result = await service.incr('counter');
      expect(result).toBe(5);
    });

    it('returns 0 (fail-open) when Redis throws', async () => {
      mockRedisInstance.incr.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.incr('counter');
      expect(result).toBe(0);
    });
  });

  describe('expire()', () => {
    it('calls client.expire with key and seconds', async () => {
      mockRedisInstance.expire.mockResolvedValue(1);
      await service.expire('k', 60);
      expect(mockRedisInstance.expire).toHaveBeenCalledWith('k', 60);
    });

    it('does not throw when Redis errors', async () => {
      mockRedisInstance.expire.mockRejectedValue(new Error('timeout'));
      await expect(service.expire('k', 60)).resolves.toBeUndefined();
    });
  });

  describe('scan()', () => {
    it('iterates SCAN cursors until exhausted and returns all keys', async () => {
      // First call: cursor '0' → next cursor '42', returns first batch
      // Second call: cursor '42' → next cursor '0' (done), returns second batch
      mockRedisInstance.scan
        .mockResolvedValueOnce(['42', ['key:1', 'key:2']])
        .mockResolvedValueOnce(['0', ['key:3']]);

      const result = await service.scan('key:*');
      expect(result).toEqual(['key:1', 'key:2', 'key:3']);
      expect(mockRedisInstance.scan).toHaveBeenCalledTimes(2);
    });

    it('returns empty array (fail-open) when Redis throws', async () => {
      mockRedisInstance.scan.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.scan('key:*');
      expect(result).toEqual([]);
    });
  });

  describe('delPattern()', () => {
    it('scans, deletes matched keys in batches, returns count', async () => {
      mockRedisInstance.scan
        .mockResolvedValueOnce(['42', ['semantic:s1:a', 'semantic:s1:b']])
        .mockResolvedValueOnce(['0', ['semantic:s1:c']]);
      mockRedisInstance.del.mockResolvedValue(2);

      const count = await service.delPattern('semantic:s1:*');
      // 3 keys total across 2 batches
      expect(count).toBe(3);
      // First batch del: 2 keys, second batch del: 1 key
      expect(mockRedisInstance.del).toHaveBeenCalledTimes(2);
    });

    it('skips DEL when a scan batch is empty', async () => {
      mockRedisInstance.scan.mockResolvedValueOnce(['0', []]);
      const count = await service.delPattern('semantic:s2:*');
      expect(count).toBe(0);
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });

    it('returns 0 (fail-open) when Redis throws', async () => {
      mockRedisInstance.scan.mockRejectedValue(new Error('ECONNREFUSED'));
      const count = await service.delPattern('semantic:s3:*');
      expect(count).toBe(0);
    });
  });
});
