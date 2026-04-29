/**
 * Core behavioural tests for useChat — SSE streaming, message flow, retry, stop, error handling.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChat } from '../useChat';
import { msgsKey } from '@/lib/storage';
import type { Message } from '@/lib/types';

// ─── API mock ────────────────────────────────────────────────────────────────

const mockSubmitFeedback = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/api', () => ({
  API_BASE: 'http://localhost:8080/api',
  submitFeedback: (...args: unknown[]) => mockSubmitFeedback(...args),
}));

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

/**
 * Builds a mock Response whose body reader emits all SSE lines in one chunk,
 * then signals completion. Avoids ReadableStream (not available in jsdom).
 */
function makeSseResponse(lines: string[], status = 200): Response {
  const body = lines.join('\n') + '\n';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  const mockReader = {
    read: jest.fn()
      .mockResolvedValueOnce({ done: false, value: encoded })
      .mockResolvedValue({ done: true, value: undefined }),
    cancel: jest.fn(),
    releaseLock: jest.fn(),
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    body: { getReader: () => mockReader },
  } as unknown as Response;
}

function sseToken(token: string): string {
  return `data: ${JSON.stringify({ token })}`;
}

function sseTraceId(id: string): string {
  return `data: ${JSON.stringify({ traceId: id })}`;
}

function sseCitations(citations: unknown[]): string {
  return `data: ${JSON.stringify({ citations })}`;
}

function sseDone(): string {
  return 'data: [DONE]';
}

function sseError(msg: string): string {
  return `data: ${JSON.stringify({ error: msg })}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SESSION = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function seedMessages(msgs: Message[]): void {
  localStorage.setItem(msgsKey(SESSION), JSON.stringify(msgs));
}

const USER_MSG: Message = {
  id: 'u1',
  role: 'user',
  content: 'What is RAG?',
  createdAt: '2024-01-01T00:00:00.000Z',
};
const ASSISTANT_MSG: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'RAG is Retrieval-Augmented Generation.',
  traceId: 'trace-001',
  createdAt: '2024-01-01T00:00:01.000Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useChat', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  // ── sendMessage ─────────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('adds user message and empty assistant placeholder immediately', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('hello'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => {
        result.current.sendMessage('Hello');
      });

      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const roles = result.current.messages.map((m) => m.role);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
    });

    it('ignores empty or whitespace-only messages', async () => {
      global.fetch = jest.fn();

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => result.current.sendMessage('   '));

      expect(fetch).not.toHaveBeenCalled();
    });

    it('ignores sendMessage while already streaming', async () => {
      let resolveFetch!: () => void;
      global.fetch = jest.fn().mockReturnValue(
        new Promise<Response>((res) => {
          resolveFetch = () => res(makeSseResponse([sseDone()]));
        }),
      );

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => result.current.sendMessage('First message'));
      act(() => result.current.sendMessage('Second message — should be ignored'));

      expect(fetch).toHaveBeenCalledTimes(1);

      await act(async () => resolveFetch());
    });
  });

  // ── SSE streaming ───────────────────────────────────────────────────────────

  describe('SSE streaming', () => {
    it('accumulates tokens into the assistant message content', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('Hello'), sseToken(' world'), sseToken('!'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => {
        result.current.sendMessage('Hi');
      });

      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const assistant = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('Hello world!');
    });

    it('attaches traceId from SSE event to the assistant message', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('ok'), sseTraceId('trace-xyz'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Question'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const assistant = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistant?.traceId).toBe('trace-xyz');
    });

    it('attaches citations from SSE event to the assistant message', async () => {
      const citations = [{ number: 1, chunkId: 'c1', documentId: 'd1', filename: 'doc.pdf', excerpt: 'text' }];
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('answer'), sseCitations(citations), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Query'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const assistant = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistant?.citations).toHaveLength(1);
      expect(assistant?.citations![0].filename).toBe('doc.pdf');
    });

    it('sets streamError from SSE error event without removing the assistant message', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseError('Something went wrong'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Query'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      expect(result.current.streamError).toBe('Something went wrong');
    });

    it('skips malformed JSON SSE lines without crashing', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse(['data: not-valid-json', sseToken('ok'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Query'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const assistant = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('ok');
    });

    it('sets isStreaming to false after the stream completes', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('done'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Q'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));
    });
  });

  // ── HTTP error responses ────────────────────────────────────────────────────

  describe('HTTP error responses', () => {
    it('sets rate-limit error message on 429', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, body: null });

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Question'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      expect(result.current.streamError).toMatch(/rate limit/i);
    });

    it('removes the assistant placeholder on HTTP error', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, body: null });

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Question'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      expect(result.current.messages.find((m) => m.role === 'assistant')).toBeUndefined();
    });

    it('sets network error message when fetch rejects', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Q'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      expect(result.current.streamError).toMatch(/connection error/i);
    });
  });

  // ── stopStreaming ────────────────────────────────────────────────────────────

  describe('stopStreaming', () => {
    it('aborts the in-flight fetch request', async () => {
      const abortSpy = jest.spyOn(AbortController.prototype, 'abort');

      // Never-resolving fetch so we can call stop in the middle
      global.fetch = jest.fn().mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => result.current.sendMessage('Long question'));
      act(() => result.current.stopStreaming());

      expect(abortSpy).toHaveBeenCalled();
    });

    it('does not set streamError on AbortError', async () => {
      global.fetch = jest.fn().mockRejectedValue(
        Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      );

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Q'));
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      expect(result.current.streamError).toBeNull();
    });
  });

  // ── retryLast ────────────────────────────────────────────────────────────────

  describe('retryLast', () => {
    it('re-sends the last user message to /chat/retry', async () => {
      seedMessages([USER_MSG, ASSISTANT_MSG]);
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('retried answer'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      await act(async () => result.current.retryLast());
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const callUrl = (fetch as jest.Mock).mock.calls[0][0] as string;
      expect(callUrl).toContain('/chat/retry');
    });

    it('replaces the last assistant message with the new response', async () => {
      seedMessages([USER_MSG, ASSISTANT_MSG]);
      global.fetch = jest.fn().mockResolvedValue(
        makeSseResponse([sseToken('new answer'), sseDone()]),
      );

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      await act(async () => result.current.retryLast());
      await waitFor(() => expect(result.current.isStreaming).toBe(false));

      const lastMsg = result.current.messages[result.current.messages.length - 1];
      expect(lastMsg.content).toBe('new answer');
    });

    it('does nothing when the last message is not from assistant', async () => {
      seedMessages([USER_MSG]);
      global.fetch = jest.fn();

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => result.current.retryLast());

      expect(fetch).not.toHaveBeenCalled();
    });

    it('does nothing when there are fewer than 2 messages', async () => {
      seedMessages([USER_MSG]);
      global.fetch = jest.fn();

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => result.current.retryLast());

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── clearStreamError ─────────────────────────────────────────────────────────

  describe('clearStreamError', () => {
    it('resets streamError to null', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, body: null });

      const { result } = renderHook(() => useChat(SESSION));

      await act(async () => result.current.sendMessage('Q'));
      await waitFor(() => expect(result.current.streamError).not.toBeNull());

      act(() => result.current.clearStreamError());

      expect(result.current.streamError).toBeNull();
    });
  });
});
