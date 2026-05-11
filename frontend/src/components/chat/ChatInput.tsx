'use client';

import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX_CHARS = 2000;

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  hasReadyDocs: boolean;
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  hasReadyDocs,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDisabled = !hasReadyDocs && !isStreaming;
  const isOverLimit = value.length > MAX_CHARS;

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || isDisabled || isOverLimit) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  return (
    <div className="relative shrink-0 px-4 pb-5 pt-0">
      {/* Rich teal gradient wash — the glass card blurs this through to create frosted effect */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 top-0"
        style={{
          background:
            'linear-gradient(to bottom, transparent 0%, oklch(0.68 0.14 220 / 20%) 100%)',
        }}
      />

      {/* Gradient separator line */}
      <div
        className="pointer-events-none relative mb-3 h-[1px] w-full"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, oklch(0.58 0.13 220 / 60%) 50%, transparent 100%)',
        }}
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-3xl">
        <div
          className={cn(
            'relative flex items-center gap-3 rounded-2xl px-4 py-3',
            'backdrop-blur-2xl transition-all duration-200',
            isDisabled && 'cursor-not-allowed opacity-60',
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            background: 'var(--glass-input-bg)',
            border: '1.5px solid var(--glass-input-border)',
            boxShadow: focused ? 'var(--glass-input-focus-shadow)' : 'var(--glass-input-idle-shadow)',
          }}
        >
          <Textarea
            ref={textareaRef}
            value={value}
            disabled={isDisabled}
            placeholder={
              hasReadyDocs
                ? 'Ask about your documents…'
                : 'Upload a document to start chatting'
            }
            rows={1}
            className={cn(
              'min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none',
              'focus-visible:ring-0 focus-visible:ring-offset-0',
              'placeholder:text-muted-foreground/50',
              'leading-relaxed',
            )}
            onChange={(e) => {
              setValue(e.target.value);
              autoResize();
            }}
            onKeyDown={handleKeyDown}
          />

          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="mb-0.5 shrink-0 rounded-xl p-2 text-destructive hover:bg-destructive/10 transition-colors"
              aria-label="Stop generating"
            >
              <Square className="size-4 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!value.trim() || isDisabled || isOverLimit}
              onClick={handleSend}
              className={cn(
                'brand-gradient mb-0.5 shrink-0 rounded-xl p-2 text-white transition-all',
                'shadow-[0_2px_8px_oklch(0.35_0.15_220_/_30%)]',
                'hover:opacity-90 hover:shadow-[0_4px_12px_oklch(0.35_0.15_220_/_40%)]',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
              )}
              aria-label="Send message"
            >
              <Send className="size-4" />
            </button>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between px-1">
          <p className="text-xs text-muted-foreground/40">
            Enter to send · Shift+Enter for new line
          </p>
          {value.length > 0 && (
            <span
              className={cn(
                'text-xs tabular-nums',
                isOverLimit ? 'text-destructive' : 'text-muted-foreground/40',
              )}
              aria-live="polite"
              aria-label={`${value.length} of ${MAX_CHARS} characters`}
            >
              {value.length}/{MAX_CHARS}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
