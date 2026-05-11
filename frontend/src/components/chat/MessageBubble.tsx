'use client';

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { cn } from '@/lib/utils';
import type { Message } from '@/lib/types';
import { CitationPill } from './CitationPill';
import { CitationSidePanel } from './CitationSidePanel';
import { FeedbackBar } from './FeedbackBar';

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
  isLast: boolean;
  onFeedback: (traceId: string, score: 1 | -1 | 0) => void;
  onRetry: () => void;
}

/**
 * Sanitize schema that allows <cite data-n> (inline citations) and the
 * SVG/span elements emitted by rehype-katex for math rendering.
 * All unsafe HTML (scripts, img onerror, iframes, event handlers) is stripped.
 */
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'cite',
    // KaTeX output tags
    'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac',
    'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr',
    'mtd', 'mtext', 'mspace', 'menclose', 'annotation', 'semantics',
  ],
  attributes: {
    ...defaultSchema.attributes,
    cite: ['dataN'],
    // Allow all attributes on math elements (KaTeX needs xmlns, display, etc.)
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'style', 'xmlns', 'display'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
  },
};

// Accept both ASCII [Source N] and full-width 【Source N】 — some models emit the latter.
const SOURCE_CITE_RE = /[\[【]Source\s+(\d+)[\]】]/g;
const SOURCE_STRIP_RE = /[\[【]Source\s+\d+[\]】]/g;

// Matches a line whose only non-whitespace content is one or more citation markers.
// These are duplicates the LLM places below the sentence that already cites inline.
const STANDALONE_CITE_LINE_RE = /^[ \t]*(?:(?:[-*]|\d+\.)[ \t]+)?(?:[\[【]Source\s+\d+[\]】][ \t]*)+(?:\r?\n|$)/gm;

/**
 * Prepares AI response text for ReactMarkdown:
 *  1. Strips citation markers that appear alone on their own line (LLM duplicates).
 *  2. Normalises LaTeX display math \[...\] → $$...$$ for remark-math.
 *  3. Normalises LaTeX inline math \(...\) → $...$ for remark-math.
 *  4. Converts remaining inline [Source N] markers to <cite data-n="N"> elements.
 */
function prepareContent(content: string): string {
  let out = content;

  // 1. Remove lines that are only citation markers (duplicates from the LLM)
  out = out.replace(STANDALONE_CITE_LINE_RE, '');

  // 2. Display math: \[...\]  →  $$...$$
  out = out.replace(/\\\[([^]*?)\\\]/g, (_m, math: string) => `$$${math}$$`);

  // 3. Inline math: \(...\)  →  $...$
  out = out.replace(/\\\(([^]*?)\\\)/g, (_m, math: string) => `$${math}$`);

  // 4. Inline citation markers → <cite> elements
  SOURCE_CITE_RE.lastIndex = 0;
  out = out.replace(SOURCE_CITE_RE, '<cite data-n="$1"></cite>');

  return out;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateStr} · ${time}`;
}

function MessageBubbleInner({
  message,
  isStreaming,
  isLast,
  onFeedback,
  onRetry,
}: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div
        className="flex flex-col items-end px-4 py-1.5"
        style={{ animation: 'message-in 0.2s ease-out both' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Gradient user bubble */}
        <div
          className="max-w-[75%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-white"
          style={{
            background: 'linear-gradient(135deg, oklch(0.35 0.15 220) 0%, oklch(0.58 0.13 220) 100%)',
            boxShadow: '0 4px 16px oklch(0.35 0.15 220 / 30%)',
          }}
        >
          <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
        </div>

        {/* Hover timestamp */}
        <span
          className={cn(
            'mt-1 text-[11px] text-muted-foreground/50 transition-opacity duration-150',
            hovered ? 'opacity-100' : 'opacity-0',
          )}
        >
          {formatTimestamp(message.createdAt)}
        </span>
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
    <div
      className="flex flex-col px-4 py-1.5 outline-none"
      style={{ animation: 'message-in 0.2s ease-out both' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="max-w-[85%]">
        {/* Response prose with inline citation badges */}
        <div
          className={cn(
            'rounded-2xl rounded-bl-sm bg-card px-4 py-3 text-sm outline-none',
            'border border-border/50',
            'prose prose-sm dark:prose-invert max-w-none break-words',
            'prose-p:my-1 prose-p:leading-relaxed',
            'prose-headings:font-semibold',
            'prose-code:rounded prose-code:bg-muted-foreground/10 prose-code:px-1 prose-code:text-foreground',
            'prose-pre:overflow-x-auto prose-pre:border prose-pre:border-border prose-pre:bg-muted-foreground/5',
            '[&_pre]:border-l-2 [&_pre]:border-l-[oklch(0.58_0.13_220)]',
            'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
          )}
          style={{
            /* Tight shadow — doesn't extend into feedback/timestamp area below */
            boxShadow: '0 1px 2px oklch(0.20 0.02 220 / 8%), 0 2px 8px oklch(0.20 0.02 220 / 5%)',
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeRaw, rehypeKatex, [rehypeSanitize, sanitizeSchema]]}
            components={{
              // Render <cite data-n="N"> as an inline CitationPill with tooltip.
              cite: ({ node }) => {
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
                  />
                );
              },
            }}
          >
            {renderedContent}
          </ReactMarkdown>
          {isStreaming && isLast && (
            <span
              className="inline-block h-[0.9em] w-[0.5em] rounded-sm align-middle"
              style={{
                backgroundColor: 'oklch(0.58 0.13 220)',
                animation: 'blink-cursor 1s step-end infinite',
              }}
              aria-hidden="true"
            />
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

        {/* Hover timestamp */}
        <span
          className={cn(
            'mt-1 block text-[11px] text-muted-foreground/50 transition-opacity duration-150',
            hovered ? 'opacity-100' : 'opacity-0',
          )}
        >
          {formatTimestamp(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner);
