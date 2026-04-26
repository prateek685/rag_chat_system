'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { cn } from '@/lib/utils';
import type { Message } from '@/lib/types';
import { CitationPill } from './CitationPill';
import { CitationSidePanel } from './CitationSidePanel';
import { FeedbackBar } from './FeedbackBar';

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
  isLast: boolean;
  onFeedback: (traceId: string, score: 1 | -1) => void;
  onRetry: () => void;
}

/**
 * Converts [Source N] markers into <cite data-n="N"></cite> elements so a single
 * ReactMarkdown pass can render the full document (no splitting) while still
 * embedding inline citation badges exactly where the LLM placed them.
 * rehype-raw allows the <cite> tags to survive the unified pipeline.
 */
// Accept both ASCII [Source N] and full-width 【Source N】 — some models emit the latter.
const SOURCE_CITE_RE = /[\[【]Source\s+(\d+)[\]】]/g;
const SOURCE_STRIP_RE = /[\[【]Source\s+\d+[\]】]/g;

function prepareContent(content: string): string {
  SOURCE_CITE_RE.lastIndex = 0;
  return content.replace(SOURCE_CITE_RE, '<cite data-n="$1"></cite>');
}

export function MessageBubble({
  message,
  isStreaming,
  isLast,
  onFeedback,
  onRetry,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  const hasCitations =
    !isStreaming && message.citations && message.citations.length > 0;

  // During streaming [Source N] tags are partial — show raw content without processing.
  const renderedContent = isStreaming
    ? message.content.replace(SOURCE_STRIP_RE, '')
    : prepareContent(message.content);

  return (
    <div className="flex flex-col px-4 py-1.5">
      <div className="max-w-[85%]">
        {/* Response prose with inline citation badges */}
        <div
          className={cn(
            'rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm',
            'prose prose-sm dark:prose-invert max-w-none',
            'prose-p:my-1 prose-p:leading-relaxed',
            'prose-headings:font-semibold',
            'prose-code:rounded prose-code:bg-muted-foreground/10 prose-code:px-1 prose-code:text-foreground',
            'prose-pre:border prose-pre:border-border prose-pre:bg-muted-foreground/5',
            'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              // Render <cite data-n="N"> as an inline CitationPill with tooltip.
              cite: ({ node, ...props }) => {
                const num = (node as { properties?: { dataN?: string } })
                  ?.properties?.dataN ?? '';
                const numInt = parseInt(num, 10);
                const citation = message.citations?.find(
                  (c) => c.number === numInt,
                );
                return (
                  <CitationPill
                    number={num}
                    citation={citation}
                    className="mx-0.5"
                    {...(props as object)}
                  />
                );
              },
            }}
          >
            {renderedContent}
          </ReactMarkdown>
          {isStreaming && isLast && (
            <span className="inline-block animate-pulse text-muted-foreground">
              ▊
            </span>
          )}
        </div>

        {/* Sources button — only after streaming, only when citations exist */}
        {hasCitations && (
          <div className="mt-1.5 px-1">
            <CitationSidePanel citations={message.citations!} />
          </div>
        )}

        {!isStreaming && (
          <FeedbackBar
            traceId={message.traceId}
            feedback={message.feedback}
            isLast={isLast}
            onFeedback={onFeedback}
            onRetry={onRetry}
          />
        )}
      </div>
    </div>
  );
}
