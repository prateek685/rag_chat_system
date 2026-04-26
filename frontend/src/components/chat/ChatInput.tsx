'use client';

import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDisabled = !hasReadyDocs && !isStreaming;

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
    if (!trimmed || isStreaming || isDisabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  return (
    <div className="shrink-0 border-t bg-background px-4 py-4">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'flex items-end gap-3 rounded-2xl border bg-background px-4 py-3',
            'shadow-sm focus-within:ring-2 focus-within:ring-ring/50',
            isDisabled && 'cursor-not-allowed opacity-60',
          )}
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
            rows={2}
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
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onStop}
              className="mb-0.5 shrink-0 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Square className="size-4 fill-current" />
              <span className="sr-only">Stop generating</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="default"
              disabled={!value.trim() || isDisabled}
              onClick={handleSend}
              className="mb-0.5 shrink-0 rounded-xl"
            >
              <Send className="size-4" />
              <span className="sr-only">Send message</span>
            </Button>
          )}
        </div>

        <p className="mt-2 text-center text-xs text-muted-foreground/40">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
