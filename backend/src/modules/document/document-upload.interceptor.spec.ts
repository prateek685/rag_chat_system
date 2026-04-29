// fs.mkdirSync must be mocked before the module under test is imported.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
}));

import * as path from 'path';
import * as fs from 'fs';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentUploadInterceptor,
  buildMulterOptions,
} from './document-upload.interceptor';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(uploadsPath = '/tmp/uploads'): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'UPLOADS_PATH') return uploadsPath;
      return undefined;
    }),
  } as unknown as ConfigService;
}

/** DiskStorage exposes these as own properties (multer v2). */
type DiskStorageInternal = {
  getDestination: (req: unknown, file: unknown, cb: (err: null, dir: string) => void) => void;
  getFilename: (req: unknown, file: unknown, cb: (err: null, name: string) => void) => void;
};

// ─── Construction ────────────────────────────────────────────────────────────

describe('DocumentUploadInterceptor', () => {
  describe('construction', () => {
    it('instantiates without throwing for a valid uploads path', () => {
      expect(() => new DocumentUploadInterceptor(makeConfig('/tmp/uploads'))).not.toThrow();
    });

    it('falls back to process.cwd()/uploads when UPLOADS_PATH is not configured', () => {
      const config = {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;

      expect(() => new DocumentUploadInterceptor(config)).not.toThrow();
    });
  });

  describe('intercept()', () => {
    it('delegates to the inner Multer interceptor', () => {
      const interceptor = new DocumentUploadInterceptor(makeConfig());

      const mockDelegate = { intercept: jest.fn().mockReturnValue('delegated') };
      (interceptor as unknown as { delegate: unknown }).delegate = mockDelegate;

      const ctx = {} as never;
      const next = {} as never;
      interceptor.intercept(ctx, next);

      expect(mockDelegate.intercept).toHaveBeenCalledWith(ctx, next);
    });
  });
});

// ─── buildMulterOptions — production callback coverage ───────────────────────

describe('buildMulterOptions — fileFilter', () => {
  const opts = buildMulterOptions('/tmp/uploads');

  function runFilter(mime: string): { err: unknown; ok: boolean } {
    let result = { err: null as unknown, ok: false };
    opts.fileFilter!(
      {} as never,
      { mimetype: mime } as never,
      (e: unknown, v: boolean) => { result = { err: e, ok: v }; },
    );
    return result;
  }

  it.each(['text/plain', 'text/csv', 'text/markdown', 'application/pdf'])(
    'accepts %s',
    (mime) => {
      const { err, ok } = runFilter(mime);
      expect(err).toBeNull();
      expect(ok).toBe(true);
    },
  );

  it.each(['image/png', 'application/json', 'application/zip', 'text/html', 'video/mp4'])(
    'rejects %s with UnsupportedMediaTypeException',
    (mime) => {
      const { err, ok } = runFilter(mime);
      expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
      expect(ok).toBe(false);
    },
  );
});

describe('buildMulterOptions — destination', () => {
  const mockMkdir = fs.mkdirSync as jest.Mock;

  beforeEach(() => {
    mockMkdir.mockReturnValue(undefined);
    jest.clearAllMocks();
    mockMkdir.mockReturnValue(undefined);
  });

  it('creates the session directory and calls back with its path', () => {
    const storage = buildMulterOptions('/tmp/uploads').storage as unknown as DiskStorageInternal;
    let dir = '';
    storage.getDestination({ sessionId: 'session-42' }, {}, (_err, d) => { dir = d; });
    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/uploads/session-42', { recursive: true });
    expect(dir).toBe('/tmp/uploads/session-42');
  });

  it('falls back to "no-session" when req.sessionId is absent', () => {
    const storage = buildMulterOptions('/tmp/uploads').storage as unknown as DiskStorageInternal;
    let dir = '';
    storage.getDestination({}, {}, (_err, d) => { dir = d; });
    expect(dir).toBe('/tmp/uploads/no-session');
  });
});

describe('buildMulterOptions — filename', () => {
  const storage = buildMulterOptions('/tmp/uploads').storage as unknown as DiskStorageInternal;

  it('generates a UUID-prefixed sanitised filename preserving the extension', () => {
    let name = '';
    storage.getFilename({}, { originalname: 'my file (2024).pdf' }, (_err, n) => { name = n; });
    // uuid-v4 pattern + sanitised base + original extension
    expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-my_file__2024_\.pdf$/);
  });

  it('truncates base names longer than 50 characters', () => {
    let name = '';
    storage.getFilename({}, { originalname: 'a'.repeat(60) + '.txt' }, (_err, n) => { name = n; });
    const base = name.replace(/^[0-9a-f-]+-/, '').replace(/\.txt$/, '');
    expect(base).toHaveLength(50);
  });

  it('preserves the file extension', () => {
    let name = '';
    storage.getFilename({}, { originalname: 'report.csv' }, (_err, n) => { name = n; });
    expect(path.extname(name)).toBe('.csv');
  });
});
