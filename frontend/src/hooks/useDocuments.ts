'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import type { Document } from '@/lib/types';
import { docsKey, readStorage, writeStorage } from '@/lib/storage';
import {
  deleteDocument as apiDeleteDocument,
  getDocumentStatus,
  uploadDocument,
} from '@/lib/api';

export interface UploadError {
  filename: string;
  message: string;
}

const ALLOWED_EXTENSIONS = new Set(['.txt', '.csv', '.md', '.pdf']);
const ALLOWED_MIME = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
]);
const MAX_BYTES = 10 * 1024 * 1024;

function validateFile(file: File): string | null {
  const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;
  const mimeOk = file.type ? ALLOWED_MIME.has(file.type) : false;
  const extOk = ALLOWED_EXTENSIONS.has(ext);
  if (!mimeOk && !extOk)
    return `${file.name} — file type not allowed (.txt .csv .md .pdf)`;
  if (file.size > MAX_BYTES) return `${file.name} — exceeds 10 MB limit`;
  return null;
}

export interface UseDocumentsReturn {
  documents: Document[];
  uploadingCount: number;
  uploadErrors: UploadError[];
  clearUploadErrors: () => void;
  uploadFiles: (files: FileList | File[]) => void;
  deleteDocument: (id: string) => void;
  hasReadyDocs: boolean;
}

export function useDocuments(sessionId: string): UseDocumentsReturn {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadErrors, setUploadErrors] = useState<UploadError[]>([]);
  const pollingRef = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const persist = useCallback((docs: Document[]) => {
    if (sessionIdRef.current)
      writeStorage(docsKey(sessionIdRef.current), docs);
  }, []);

  function startPolling(jobId: string, documentId: string): void {
    // Guard against React StrictMode double-invoke and duplicate resume on refresh
    if (pollingRef.current.has(jobId)) return;

    const intervalId = setInterval(async () => {
      try {
        const s = await getDocumentStatus(jobId);
        setDocuments((prev) => {
          const next = prev.map((d) =>
            d.id === documentId
              ? {
                  ...d,
                  status: s.status,
                  tokenCount: s.tokenCount ?? d.tokenCount,
                  errorMessage: s.errorMessage ?? d.errorMessage,
                }
              : d,
          );
          if (s.status === 'COMPLETED' || s.status === 'FAILED') {
            clearInterval(pollingRef.current.get(jobId));
            pollingRef.current.delete(jobId);
            persist(next);
          }
          return next;
        });
      } catch {
        // Network error — keep polling; transient failures are recoverable
      }
    }, 2000);

    pollingRef.current.set(jobId, intervalId);
  }

  // Restore document list from localStorage and resume polling for non-terminal docs
  useEffect(() => {
    if (!sessionId) return;

    const stored = readStorage<Document[]>(docsKey(sessionId), []);
    setDocuments(stored);

    stored
      .filter((d) => d.status === 'PENDING' || d.status === 'PROCESSING')
      .forEach((d) => startPolling(d.jobId, d.id));

    return () => {
      pollingRef.current.forEach(clearInterval);
      pollingRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function uploadSingle(file: File): Promise<void> {
    const tempId = uuid();
    const placeholder: Document = {
      id: tempId,
      jobId: '',
      name: file.name,
      status: 'PENDING',
      uploadedAt: new Date().toISOString(),
    };

    setDocuments((prev) => {
      const next = [...prev, placeholder];
      persist(next);
      return next;
    });

    try {
      const res = await uploadDocument(file);
      const doc: Document = {
        id: res.documentId,
        jobId: res.jobId,
        name: file.name,
        status: 'PENDING',
        uploadedAt: new Date().toISOString(),
      };
      setDocuments((prev) => {
        const next = prev.map((d) => (d.id === tempId ? doc : d));
        persist(next);
        return next;
      });
      startPolling(res.jobId, res.documentId);
    } catch (err: unknown) {
      setDocuments((prev) => {
        const next = prev.filter((d) => d.id !== tempId);
        persist(next);
        return next;
      });

      const status = (err as { response?: { status?: number } }).response
        ?.status;
      const msg =
        status === 409
          ? `${file.name} — already uploaded in this session`
          : status === 413
            ? `${file.name} — exceeds 10 MB limit`
            : status === 415
              ? `${file.name} — file type not allowed`
              : `${file.name} — upload failed, please try again`;

      setUploadErrors((prev) => [...prev, { filename: file.name, message: msg }]);
    }
  }

  function uploadFiles(files: FileList | File[]): void {
    const arr = Array.from(files);
    const validationErrors: UploadError[] = [];
    const valid: File[] = [];

    for (const file of arr) {
      const err = validateFile(file);
      if (err) validationErrors.push({ filename: file.name, message: err });
      else valid.push(file);
    }

    if (validationErrors.length > 0)
      setUploadErrors((prev) => [...prev, ...validationErrors]);
    if (valid.length === 0) return;

    setUploadingCount((c) => c + valid.length);
    // Parallel uploads are safe: different files have different SHA-256 hashes
    void Promise.allSettled(valid.map((f) => uploadSingle(f))).finally(() => {
      setUploadingCount((c) => Math.max(0, c - valid.length));
    });
  }

  function deleteDocument(id: string): void {
    const doc = documents.find((d) => d.id === id);
    if (!doc) return;

    // Stop polling before removing from state to prevent zombie updates
    if (doc.jobId && pollingRef.current.has(doc.jobId)) {
      clearInterval(pollingRef.current.get(doc.jobId));
      pollingRef.current.delete(doc.jobId);
    }

    setDocuments((prev) => {
      const next = prev.filter((d) => d.id !== id);
      persist(next);
      return next;
    });

    apiDeleteDocument(id).catch((err: unknown) => {
      console.warn('Document delete failed:', (err as Error).message);
    });
  }

  return {
    documents,
    uploadingCount,
    uploadErrors,
    clearUploadErrors: () => setUploadErrors([]),
    uploadFiles,
    deleteDocument,
    hasReadyDocs: documents.some((d) => d.status === 'COMPLETED'),
  };
}
