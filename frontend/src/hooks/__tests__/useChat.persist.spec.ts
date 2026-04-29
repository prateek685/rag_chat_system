/**
 * Tests that every message state mutation in useChat correctly persists to
 * localStorage so that feedback and chat history survive page reloads.
 */
import { renderHook, act } from '@testing-library/react';
import { useChat } from '../useChat';
import { msgsKey } from '@/lib/storage';
import type { Message } from '@/lib/types';

jest.mock('@/lib/api', () => ({
  API_BASE: 'http://localhost:8080/api',
  submitFeedback: jest.fn().mockResolvedValue(undefined),
}));

const SESSION = 'test-session-uuid-abcd-1234';

const USER_MSG: Message = {
  id: 'u1',
  role: 'user',
  content: 'What is RAG?',
  createdAt: '2024-01-01T00:00:00.000Z',
};

const ASSISTANT_MSG: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'RAG stands for Retrieval-Augmented Generation.',
  traceId: 'trace-abc-123',
  createdAt: '2024-01-01T00:00:01.000Z',
};

function seedMessages(msgs: Message[]): void {
  localStorage.setItem(msgsKey(SESSION), JSON.stringify(msgs));
}

function readMessages(): Message[] {
  return JSON.parse(localStorage.getItem(msgsKey(SESSION)) ?? '[]') as Message[];
}

describe('useChat — localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  describe('submitFeedback', () => {
    it('persists thumbs-up score to localStorage immediately', async () => {
      seedMessages([USER_MSG, ASSISTANT_MSG]);

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => {
        result.current.submitFeedback('trace-abc-123', 1);
      });

      const stored = readMessages();
      const assistant = stored.find((m) => m.id === 'a1');
      expect(assistant?.feedback).toBe(1);
    });

    it('persists thumbs-down score to localStorage immediately', async () => {
      seedMessages([USER_MSG, ASSISTANT_MSG]);

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => {
        result.current.submitFeedback('trace-abc-123', -1);
      });

      const stored = readMessages();
      const assistant = stored.find((m) => m.id === 'a1');
      expect(assistant?.feedback).toBe(-1);
    });

    it('also updates the in-memory messages state', async () => {
      seedMessages([USER_MSG, ASSISTANT_MSG]);

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      act(() => {
        result.current.submitFeedback('trace-abc-123', 1);
      });

      const assistant = result.current.messages.find((m) => m.id === 'a1');
      expect(assistant?.feedback).toBe(1);
    });
  });

  describe('localStorage round-trip', () => {
    it('restores feedback state from localStorage on remount', async () => {
      const msgWithFeedback: Message = { ...ASSISTANT_MSG, feedback: -1 };
      seedMessages([USER_MSG, msgWithFeedback]);

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      const assistant = result.current.messages.find((m) => m.id === 'a1');
      expect(assistant?.feedback).toBe(-1);
    });

    it('restores all message fields from localStorage on remount', async () => {
      seedMessages([USER_MSG, ASSISTANT_MSG]);

      const { result } = renderHook(() => useChat(SESSION));
      await act(async () => {});

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0]).toMatchObject({ id: 'u1', role: 'user' });
      expect(result.current.messages[1]).toMatchObject({
        id: 'a1',
        role: 'assistant',
        traceId: 'trace-abc-123',
      });
    });
  });

  describe('pre-hydration guard', () => {
    it('does not overwrite localStorage with an empty array before hydration completes', async () => {
      seedMessages([USER_MSG]);

      renderHook(() => useChat(SESSION));
      await act(async () => {});

      const stored = readMessages();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.id).toBe('u1');
    });

    it('does not write to localStorage when sessionId is empty', () => {
      seedMessages([USER_MSG]);

      renderHook(() => useChat(''));

      // Storage must remain untouched since sessionId is empty
      const stored = readMessages();
      expect(stored).toHaveLength(1);
    });
  });
});
