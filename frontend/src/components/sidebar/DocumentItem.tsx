'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Document, DocumentStatus } from '@/lib/types';

const STATUS_STYLES: Record<DocumentStatus, string> = {
  PENDING:
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  PROCESSING:
    'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  COMPLETED:
    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  FAILED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

const STATUS_LABELS: Record<DocumentStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  COMPLETED: 'Ready',
  FAILED: 'Failed',
};

interface DocumentItemProps {
  doc: Document;
  onDelete: (id: string) => void;
}

export function DocumentItem({ doc, onDelete }: DocumentItemProps) {
  return (
    <div className="group flex items-start justify-between gap-2 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium leading-tight"
          title={doc.name}
        >
          {doc.name}
        </p>
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_STYLES[doc.status],
            )}
          >
            {doc.status === 'PROCESSING' && (
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
            )}
            {STATUS_LABELS[doc.status]}
          </span>
          {doc.status === 'FAILED' && doc.errorMessage && (
            <span
              className="truncate text-xs text-muted-foreground"
              title={doc.errorMessage}
            >
              {doc.errorMessage}
            </span>
          )}
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => onDelete(doc.id)}
            />
          }
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">Remove {doc.name}</span>
        </TooltipTrigger>
        <TooltipContent>Remove document</TooltipContent>
      </Tooltip>
    </div>
  );
}
