'use client';

import { useEffect, useRef } from 'react';
import { Upload, MessageSquare, Clock } from 'lucide-react';
import type { Message } from '@/lib/types';
import { MessageBubble } from './MessageBubble';

interface ChatWindowProps {
  messages: Message[];
  isStreaming: boolean;
  onFeedback: (traceId: string, score: 1 | -1 | 0) => void;
  onRetry: () => void;
}

const STEPS = [
  { icon: Upload,        label: 'Upload a file',       desc: 'PDF, CSV, TXT, or Markdown' },
  { icon: Clock,         label: 'Wait for processing', desc: 'Usually takes a few seconds' },
  { icon: MessageSquare, label: 'Ask questions',       desc: 'About anything in your documents' },
] as const;

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
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          {/* Gradient icon circle */}
          <div
            className="brand-gradient mx-auto mb-4 flex size-14 items-center justify-center rounded-full"
            style={{ boxShadow: '0 6px 20px oklch(0.35 0.15 220 / 25%)' }}
          >
            <MessageSquare className="size-7 text-white" aria-hidden="true" />
          </div>

          <h2 className="text-lg font-semibold text-foreground">
            Start a conversation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask anything about your uploaded documents
          </p>

          {/* 3-step guide */}
          <div className="mt-6 space-y-2.5">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl px-4 py-3 text-left"
                  style={{ backgroundColor: 'var(--step-card-bg)' }}
                >
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: 'oklch(0.58 0.13 220)' }}
                  >
                    {i + 1}
                  </span>
                  <Icon
                    className="size-4 shrink-0"
                    style={{ color: 'var(--step-icon-color)' }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {step.label}
                    </p>
                    <p className="text-xs text-muted-foreground">{step.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
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
      aria-live="polite"
      aria-label="Chat messages"
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
