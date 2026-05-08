'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import type { Citation, Message } from '@/lib/types';
import { msgsKey, readStorage, writeStorage } from '@/lib/storage';
import { API_BASE, submitFeedback as apiSubmitFeedback } from '@/lib/api';

export interface UseChatReturn {
  messages: Message[];
  isStreaming: boolean;
  streamError: string | null;
  clearStreamError: () => void;
  sendMessage: (text: string) => void;
  stopStreaming: () => void;
  retryLast: () => void;
  submitFeedback: (traceId: string, score: 1 | -1 | 0) => void;
}

export function useChat(sessionId: string): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef(sessionId);

  // Rehydrate messages from localStorage once sessionId is available after hydration
  useEffect(() => {
    if (!sessionId) return;
    sessionIdRef.current = sessionId;
    setMessages(readStorage<Message[]>(msgsKey(sessionId), []));
  }, [sessionId]);

  // NOTE: localStorage writes are handled surgically:
  //   1. After streaming completes (in stream() finally) — avoids 100+ writes per response.
  //   2. After submitFeedback — so feedback survives a page reload immediately.
  // A reactive effect is intentionally NOT used here to avoid storage thrashing.

  const stream = useCallback(
    async (endpoint: string, body: Record<string, unknown>, isRetry: boolean) => {
      if (!sessionIdRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      setStreamError(null);

      let accContent = '';
      const assistantId = uuid();

      if (isRetry) {
        setMessages((prev) => {
          const withoutLast = prev.slice(0, -1);
          return [
            ...withoutLast,
            {
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            },
          ];
        });
      } else {
        const userMsg: Message = {
          id: uuid(),
          role: 'user',
          content: (body.message as string) ?? '',
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [
          ...prev,
          userMsg,
          {
            id: assistantId,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
          },
        ]);
      }

      try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': sessionIdRef.current,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const msg =
            res.status === 429
              ? 'Rate limit reached — max 10 messages per minute. Please wait before sending again.'
              : `Request failed (${res.status}). Please try again.`;
          setStreamError(msg);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';
        let done = false;

        while (!done) {
          const { done: readDone, value } = await reader.read();
          if (readDone) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const parts = lineBuffer.split('\n');
          lineBuffer = parts.pop() ?? '';

          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();

            if (payload === '[DONE]') {
              done = true;
              break;
            }

            try {
              const parsed = JSON.parse(payload) as {
                token?: string;
                traceId?: string;
                citations?: Citation[];
                error?: string;
              };

              if (parsed.token) {
                accContent += parsed.token;
                const snapshot = accContent;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: snapshot } : m,
                  ),
                );
              }

              if (parsed.traceId) {
                const traceId = parsed.traceId;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, traceId } : m,
                  ),
                );
              }

              if (parsed.citations) {
                const citations = parsed.citations;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, citations } : m,
                  ),
                );
              }

              if (parsed.error) {
                setStreamError(parsed.error);
              }
            } catch {
              // Malformed JSON line — skip
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setStreamError(
            'Connection error. Please check your network and try again.',
          );
        }
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        // Single write per stream — avoids 100+ writes during token delivery.
        setMessages((prev) => {
          if (sessionIdRef.current) {
            writeStorage(msgsKey(sessionIdRef.current), prev);
          }
          return prev;
        });
      }
    },
    [],
  );

  function sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    void stream('/chat', { message: trimmed }, false);
  }

  function stopStreaming(): void {
    abortRef.current?.abort();
  }

  function retryLast(): void {
    if (isStreaming || messages.length < 2) return;
    if (messages[messages.length - 1]?.role !== 'assistant') return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    void stream(
      '/chat/retry',
      { message: lastUserMsg.content, skipCache: true },
      true,
    );
  }

  function submitFeedback(traceId: string, score: 1 | -1 | 0): void {
    setMessages((prev) => {
      const updated = prev.map((m) =>
        m.traceId === traceId
          ? { ...m, feedback: score === 0 ? undefined : score }
          : m,
      );
      if (sessionIdRef.current) {
        writeStorage(msgsKey(sessionIdRef.current), updated);
      }
      return updated;
    });
    // Score 0 means "clear feedback" — no API call needed.
    if (score !== 0) {
      apiSubmitFeedback({ traceId, score }).catch((err: unknown) => {
        console.warn('Feedback submission failed:', err);
      });
    }
  }

  return {
    messages,
    isStreaming,
    streamError,
    clearStreamError: () => setStreamError(null),
    sendMessage,
    stopStreaming,
    retryLast,
    submitFeedback,
  };
}
