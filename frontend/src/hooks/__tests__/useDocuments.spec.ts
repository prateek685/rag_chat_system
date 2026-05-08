import { renderHook, act, waitFor } from '@testing-library/react';
import { useDocuments } from '../useDocuments';
import { docsKey } from '@/lib/storage';
import type { Document } from '@/lib/types';

// ─── API mocks ───────────────────────────────────────────────────────────────

const mockUploadDocument = jest.fn();
const mockGetDocumentStatus = jest.fn();
const mockDeleteDocument = jest.fn();

jest.mock('@/lib/api', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
  getDocumentStatus: (...args: unknown[]) => mockGetDocumentStatus(...args),
  deleteDocument: (...args: unknown[]) => mockDeleteDocument(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SESSION = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function readDocs(): Document[] {
  return JSON.parse(localStorage.getItem(docsKey(SESSION)) ?? '[]') as Document[];
}

function seedDocs(docs: Document[]): void {
  localStorage.setItem(docsKey(SESSION), JSON.stringify(docs));
}

function makeFile(name = 'report.pdf', type = 'application/pdf', size = 1024): File {
  return new File(['x'.repeat(size)], name, { type });
}

function makeCompletedDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    jobId: 'job-1',
    name: 'report.pdf',
    status: 'COMPLETED',
    uploadedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useDocuments', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── hydration ──────────────────────────────────────────────────────────────

  describe('hydration from localStorage', () => {
    it('restores documents from localStorage on mount', async () => {
      const stored = [makeCompletedDoc()];
      seedDocs(stored);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      expect(result.current.documents).toHaveLength(1);
      expect(result.current.documents[0].id).toBe('doc-1');
    });

    it('starts with an empty list when localStorage is empty', async () => {
      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      expect(result.current.documents).toHaveLength(0);
    });

    it('reports hasReadyDocs true when a COMPLETED doc exists', async () => {
      seedDocs([makeCompletedDoc({ status: 'COMPLETED' })]);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      expect(result.current.hasReadyDocs).toBe(true);
    });

    it('reports hasReadyDocs false when no COMPLETED docs exist', async () => {
      seedDocs([makeCompletedDoc({ status: 'PROCESSING' })]);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      expect(result.current.hasReadyDocs).toBe(false);
    });

    it('resumes polling for PENDING documents found in localStorage', async () => {
      seedDocs([makeCompletedDoc({ status: 'PENDING', jobId: 'job-pending' })]);
      mockGetDocumentStatus.mockResolvedValue({ status: 'COMPLETED', tokenCount: 100 });

      renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      // Advance past the 2-second polling interval
      await act(async () => {
        jest.advanceTimersByTime(2500);
      });

      expect(mockGetDocumentStatus).toHaveBeenCalledWith('job-pending');
    });
  });

  // ── validation ─────────────────────────────────────────────────────────────

  describe('uploadFiles — client-side validation', () => {
    it('rejects a file with a disallowed MIME type', async () => {
      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.uploadFiles([makeFile('image.png', 'image/png')]);
      });

      expect(result.current.uploadErrors).toHaveLength(1);
      expect(result.current.uploadErrors[0].message).toMatch(/not allowed/i);
      expect(mockUploadDocument).not.toHaveBeenCalled();
    });

    it('rejects a file that exceeds 10 MB', async () => {
      const bigFile = makeFile('huge.pdf', 'application/pdf', 11 * 1024 * 1024);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.uploadFiles([bigFile]);
      });

      expect(result.current.uploadErrors[0].message).toMatch(/10 MB/i);
      expect(mockUploadDocument).not.toHaveBeenCalled();
    });

    it('accepts .txt, .csv, .md, and .pdf files', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc-x', jobId: 'job-x' });
      mockGetDocumentStatus.mockResolvedValue({ status: 'COMPLETED' });

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([
          makeFile('a.txt', 'text/plain'),
          makeFile('b.csv', 'text/csv'),
          makeFile('c.md', 'text/markdown'),
          makeFile('d.pdf', 'application/pdf'),
        ]);
      });

      expect(result.current.uploadErrors).toHaveLength(0);
      expect(mockUploadDocument).toHaveBeenCalledTimes(4);
    });

    it('collects mixed validation errors and valid files in one call', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc-v', jobId: 'job-v' });

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([
          makeFile('valid.pdf', 'application/pdf'),
          makeFile('bad.exe', 'application/x-msdownload'),
        ]);
      });

      expect(result.current.uploadErrors).toHaveLength(1);
      expect(mockUploadDocument).toHaveBeenCalledTimes(1);
    });
  });

  // ── upload flow ────────────────────────────────────────────────────────────

  describe('uploadFiles — upload flow', () => {
    it('adds a placeholder document immediately, then replaces it after API resolves', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc-new', jobId: 'job-new' });
      mockGetDocumentStatus.mockResolvedValue({ status: 'COMPLETED' });

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('policy.pdf', 'application/pdf')]);
      });

      // After upload resolves the real doc should be present
      expect(result.current.documents.some((d) => d.id === 'doc-new')).toBe(true);
    });

    it('increments then decrements uploadingCount during upload', async () => {
      let resolveUpload!: (v: unknown) => void;
      mockUploadDocument.mockReturnValue(new Promise((r) => (resolveUpload = r)));

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.uploadFiles([makeFile('doc.pdf', 'application/pdf')]);
      });

      expect(result.current.uploadingCount).toBe(1);

      await act(async () => {
        resolveUpload({ documentId: 'doc-1', jobId: 'job-1' });
      });

      expect(result.current.uploadingCount).toBe(0);
    });

    it('removes placeholder and records error when upload API rejects with 409', async () => {
      const err = Object.assign(new Error('conflict'), { response: { status: 409 } });
      mockUploadDocument.mockRejectedValueOnce(err);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('dup.pdf', 'application/pdf')]);
      });

      expect(result.current.documents).toHaveLength(0);
      expect(result.current.uploadErrors[0].message).toMatch(/already uploaded/i);
    });

    it('records 413 error message for oversized files rejected by the server', async () => {
      const err = Object.assign(new Error('too large'), { response: { status: 413 } });
      mockUploadDocument.mockRejectedValueOnce(err);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('large.pdf', 'application/pdf')]);
      });

      expect(result.current.uploadErrors[0].message).toMatch(/10 MB/i);
    });

    it('records 415 error message for files rejected by the server', async () => {
      const err = Object.assign(new Error('unsupported'), { response: { status: 415 } });
      mockUploadDocument.mockRejectedValueOnce(err);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('file.pdf', 'application/pdf')]);
      });

      expect(result.current.uploadErrors[0].message).toMatch(/not allowed/i);
    });
  });

  // ── polling ────────────────────────────────────────────────────────────────

  describe('polling', () => {
    it('updates document status when poll returns PROCESSING then COMPLETED', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc-1', jobId: 'job-1' });
      mockGetDocumentStatus
        .mockResolvedValueOnce({ status: 'PROCESSING' })
        .mockResolvedValueOnce({ status: 'COMPLETED', tokenCount: 500 });

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('doc.pdf', 'application/pdf')]);
      });

      // First poll tick at 2 s (initial delay)
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });

      expect(result.current.documents.some((d) => d.status === 'PROCESSING')).toBe(true);

      // Second poll tick at 4 s (exponential backoff doubles the delay)
      await act(async () => {
        jest.advanceTimersByTime(4100);
      });

      await waitFor(() => {
        expect(result.current.documents.some((d) => d.status === 'COMPLETED')).toBe(true);
      });
    });

    it('stops polling once document reaches FAILED status', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc-1', jobId: 'job-1' });
      mockGetDocumentStatus.mockResolvedValue({ status: 'FAILED', errorMessage: 'parse error' });

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('bad.pdf', 'application/pdf')]);
      });

      await act(async () => {
        jest.advanceTimersByTime(2100);
      });

      const callsAfterFailed = mockGetDocumentStatus.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(4100);
      });

      // No additional calls after terminal status
      expect(mockGetDocumentStatus.mock.calls.length).toBe(callsAfterFailed);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  describe('deleteDocument', () => {
    it('removes the document from state immediately', async () => {
      seedDocs([makeCompletedDoc({ id: 'doc-1' })]);
      mockDeleteDocument.mockResolvedValue(undefined);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.deleteDocument('doc-1');
      });

      expect(result.current.documents.find((d) => d.id === 'doc-1')).toBeUndefined();
    });

    it('calls the delete API', async () => {
      seedDocs([makeCompletedDoc({ id: 'doc-1' })]);
      mockDeleteDocument.mockResolvedValue(undefined);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.deleteDocument('doc-1');
      });

      await act(async () => {});
      expect(mockDeleteDocument).toHaveBeenCalledWith('doc-1');
    });

    it('does nothing when given an id that does not exist', async () => {
      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.deleteDocument('non-existent-id');
      });

      expect(mockDeleteDocument).not.toHaveBeenCalled();
    });
  });

  // ── clearUploadErrors ──────────────────────────────────────────────────────

  describe('clearUploadErrors', () => {
    it('empties the uploadErrors array', async () => {
      mockUploadDocument.mockRejectedValueOnce(
        Object.assign(new Error('fail'), { response: { status: 500 } }),
      );

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('doc.pdf', 'application/pdf')]);
      });

      expect(result.current.uploadErrors.length).toBeGreaterThan(0);

      act(() => {
        result.current.clearUploadErrors();
      });

      expect(result.current.uploadErrors).toHaveLength(0);
    });
  });

  // ── localStorage persistence ───────────────────────────────────────────────

  describe('localStorage persistence', () => {
    it('persists documents to localStorage after upload', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc-stored', jobId: 'job-stored' });
      mockGetDocumentStatus.mockResolvedValue({ status: 'COMPLETED' });

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      await act(async () => {
        result.current.uploadFiles([makeFile('doc.pdf', 'application/pdf')]);
      });

      const stored = readDocs();
      expect(stored.some((d) => d.id === 'doc-stored')).toBe(true);
    });

    it('persists document deletion to localStorage', async () => {
      seedDocs([makeCompletedDoc({ id: 'doc-del' })]);
      mockDeleteDocument.mockResolvedValue(undefined);

      const { result } = renderHook(() => useDocuments(SESSION));
      await act(async () => {});

      act(() => {
        result.current.deleteDocument('doc-del');
      });

      const stored = readDocs();
      expect(stored.find((d) => d.id === 'doc-del')).toBeUndefined();
    });
  });
});
