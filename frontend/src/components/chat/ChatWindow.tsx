'use client';

import { useEffect, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import type { Message } from '@/lib/types';
import { MessageBubble } from './MessageBubble';

interface ChatWindowProps {
  messages: Message[];
  isStreaming: boolean;
  onFeedback: (traceId: string, score: 1 | -1) => void;
  onRetry: () => void;
}

export function ChatWindow({
  messages,
  isStreaming,
  onFeedback,
  onRetry,
}: ChatWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user is near the bottom so we don't force-scroll
  // them back down when they've scrolled up to read history.
  const isNearBottom = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isNearBottom.current) return;
    // Scroll directly on the container ref — never touches the body.
    el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <MessageSquare className="size-12 text-muted-foreground/25" />
          <p className="text-base font-medium text-muted-foreground">
            Start a conversation
          </p>
          <p className="text-sm text-muted-foreground/60">
            Ask anything about your uploaded documents
          </p>
        </div>
      </div>
    );
  }

  const lastAssistantIndex = messages.reduce(
    (acc, msg, i) => (msg.role === 'assistant' ? i : acc),
    -1,
  );

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isStreaming={isStreaming && i === messages.length - 1}
            isLast={i === lastAssistantIndex && msg.role === 'assistant'}
            onFeedback={onFeedback}
            onRetry={onRetry}
          />
        ))}
      </div>
    </div>
  );
}
