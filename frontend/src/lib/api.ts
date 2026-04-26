import axios, { type AxiosInstance } from 'axios';
import type { DocumentStatusResponse, FeedbackPayload, UploadResponse } from './types';

export const API_BASE =
  (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080') + '/api';

let _sessionId = '';

/** Inject the session UUID into every request. Call once after localStorage hydration. */
export function setApiSessionId(id: string): void {
  _sessionId = id;
}

const client: AxiosInstance = axios.create({ baseURL: API_BASE });

client.interceptors.request.use((config) => {
  if (_sessionId) config.headers['x-session-id'] = _sessionId;
  return config;
});

export async function uploadDocument(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await client.post<UploadResponse>('/documents/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function getDocumentStatus(
  jobId: string,
): Promise<DocumentStatusResponse> {
  const { data } = await client.get<DocumentStatusResponse>(
    `/documents/status/${jobId}`,
  );
  return data;
}

export async function deleteDocument(documentId: string): Promise<void> {
  await client.delete(`/documents/${documentId}`);
}

export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  await client.post('/chat/feedback', payload);
}
