'use client';

import { cn } from '@/lib/utils';
import type { Citation } from '@/lib/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface CitationPillProps {
  number: string;
  /** Structured metadata — shows a tooltip on hover when provided. */
  citation?: Citation;
  className?: string;
}

const pillBase =
  'inline-flex h-[1.1em] min-w-[1.1em] cursor-default select-none items-center ' +
  'justify-center rounded px-[0.25em] align-middle ' +
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 ' +
  'text-[0.65em] font-bold leading-none';

export function CitationPill({ number, citation, className }: CitationPillProps) {
  const badge = (
    <span className={cn(pillBase, className)}>
      {number}
    </span>
  );

  if (!citation) return badge;

  const title = citation.pageNumber !== undefined
    ? `${citation.filename} · Page ${citation.pageNumber}`
    : citation.filename;

  const preview = citation.excerpt.length > 120
    ? `${citation.excerpt.slice(0, 120)}…`
    : citation.excerpt;

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={badge} />
        <TooltipContent
          side="top"
          className="max-w-[260px] space-y-1 px-3 py-2 text-left"
        >
          <p className="text-[11px] font-semibold leading-tight">{title}</p>
          <p className="text-[10px] opacity-80 leading-snug">{preview}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
