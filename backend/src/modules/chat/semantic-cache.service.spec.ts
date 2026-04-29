import { Test, TestingModule } from '@nestjs/testing';
import { SemanticCacheService } from './semantic-cache.service';
import { RedisService } from '../redis/redis.service';

/** Build a unit vector of a given dimension (all equal components). */
const unitVector = (dim: number): number[] => {
  const v = Array(dim).fill(1 / Math.sqrt(dim)) as number[];
  return v;
};

/** Build a vector orthogonal-ish to unitVector — dot product ≈ 0. */
const orthogonalVector = (dim: number): number[] => {
  const v = Array(dim).fill(0) as number[];
  v[0] = 1;
  return v;
};

describe('SemanticCacheService', () => {
  let service: SemanticCacheService;
  let redis: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SemanticCacheService,
        {
          provide: RedisService,
          useValue: {
            scan: jest.fn(),
            get: jest.fn(),
            setex: jest.fn(),
            delPattern: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(SemanticCacheService);
    redis = module.get(RedisService);
  });

  afterEach(() => jest.clearAllMocks());

  // ---------------------------------------------------------------------------
  // lookup()
  // ---------------------------------------------------------------------------

  describe('lookup()', () => {
    it('returns null when no keys exist for session', async () => {
      redis.scan.mockResolvedValue([]);
      const result = await service.lookup('session-1', unitVector(4));
      expect(result).toBeNull();
    });

    it('returns the response when cosine similarity ≥ 0.98', async () => {
      const embedding = unitVector(4);
      redis.scan.mockResolvedValue(['semantic:session-1:abc']);
      redis.get.mockResolvedValue(
        JSON.stringify({ embedding, response: 'Cached answer' }),
      );

      const result = await service.lookup('session-1', embedding);
      expect(result).toBe('Cached answer');
    });

    it('returns null when best similarity is below 0.98 (near-miss)', async () => {
      const stored = unitVector(4);
      // Query vector orthogonal to stored — cosine similarity ≈ 0.5 (not a match)
      const query = [1, 0, 1, 0].map((v) => v / Math.sqrt(2));
      redis.scan.mockResolvedValue(['semantic:session-1:abc']);
      redis.get.mockResolvedValue(JSON.stringify({ embedding: stored, response: 'Cached' }));

      const result = await service.lookup('session-1', query);
      expect(result).toBeNull();
    });

    it('returns null when similarity is exactly 0.97 — just below the 0.98 threshold', async () => {
      // Construct two unit vectors in 2D with cosine similarity = 0.97.
      // stored = [1, 0]; query = [0.97, sin(θ)] where cos(θ) = 0.97.
      const stored = [1, 0];
      const query = [0.97, Math.sqrt(1 - 0.97 ** 2)];
      redis.scan.mockResolvedValue(['semantic:session-1:abc']);
      redis.get.mockResolvedValue(JSON.stringify({ embedding: stored, response: 'Cached' }));

      const result = await service.lookup('session-1', query);
      expect(result).toBeNull();
    });

    it('returns the cached response when similarity is exactly 0.98 — at the threshold', async () => {
      const stored = [1, 0];
      const query = [0.98, Math.sqrt(1 - 0.98 ** 2)];
      redis.scan.mockResolvedValue(['semantic:session-1:abc']);
      redis.get.mockResolvedValue(JSON.stringify({ embedding: stored, response: 'Exact boundary hit' }));

      const result = await service.lookup('session-1', query);
      expect(result).toBe('Exact boundary hit');
    });

    it('returns null when similarity is exactly 0 (orthogonal)', async () => {
      const dim = 4;
      redis.scan.mockResolvedValue(['semantic:session-1:abc']);
      redis.get.mockResolvedValue(
        JSON.stringify({ embedding: orthogonalVector(dim), response: 'Cached' }),
      );

      // Query vector perpendicular to stored
      const query = Array(dim).fill(0) as number[];
      query[1] = 1;

      const result = await service.lookup('session-1', query);
      expect(result).toBeNull();
    });

    it('returns null (fail-open) when scan throws', async () => {
      redis.scan.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.lookup('session-1', unitVector(4));
      expect(result).toBeNull();
    });

    it('skips entries where get() returns null and continues', async () => {
      const embedding = unitVector(4);
      redis.scan.mockResolvedValue(['semantic:s:a', 'semantic:s:b']);
      redis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ embedding, response: 'Second entry' }));

      const result = await service.lookup('s', embedding);
      expect(result).toBe('Second entry');
    });

    it('skips malformed JSON entries without throwing', async () => {
      const embedding = unitVector(4);
      redis.scan.mockResolvedValue(['semantic:s:a', 'semantic:s:b']);
      redis.get
        .mockResolvedValueOnce('not-valid-json{{{')
        .mockResolvedValueOnce(JSON.stringify({ embedding, response: 'Valid entry' }));

      const result = await service.lookup('s', embedding);
      expect(result).toBe('Valid entry');
    });

    it('caps scan results to 100 entries to bound lookup cost', async () => {
      const keys = Array.from({ length: 150 }, (_, i) => `semantic:s:${i}`);
      redis.scan.mockResolvedValue(keys);
      redis.get.mockResolvedValue(null);

      await service.lookup('s', unitVector(4));

      // Only the first 100 keys should be fetched
      expect(redis.get).toHaveBeenCalledTimes(100);
    });
  });

  // ---------------------------------------------------------------------------
  // store()
  // ---------------------------------------------------------------------------

  describe('store()', () => {
    it('calls redis.setex with session-scoped key, 24h TTL, and JSON value', async () => {
      redis.setex.mockResolvedValue(undefined);
      const embedding = unitVector(4);

      await service.store('session-1', embedding, 'My response');

      expect(redis.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, value] = redis.setex.mock.calls[0] as [string, number, string];

      expect(key).toMatch(/^semantic:session-1:[0-9a-f]{8}$/);
      expect(ttl).toBe(86_400);
      const parsed = JSON.parse(value) as { embedding: number[]; response: string };
      expect(parsed.embedding).toEqual(embedding);
      expect(parsed.response).toBe('My response');
    });

    it('does not throw when redis.setex fails (fail-open)', async () => {
      redis.setex.mockRejectedValue(new Error('timeout'));
      // setex internally fail-opens in RedisService, so this resolves cleanly
      await expect(service.store('s', unitVector(4), 'r')).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // invalidateSession()
  // ---------------------------------------------------------------------------

  describe('invalidateSession()', () => {
    it('calls redis.delPattern with the correct session pattern', async () => {
      redis.delPattern.mockResolvedValue(3);
      await service.invalidateSession('session-42');
      expect(redis.delPattern).toHaveBeenCalledWith('semantic:session-42:*');
    });

    it('does not throw when delPattern returns 0 (no keys)', async () => {
      redis.delPattern.mockResolvedValue(0);
      await expect(service.invalidateSession('s')).resolves.toBeUndefined();
    });
  });
});
