'use client';

import { memo, useState } from 'react';
import { Trash2, FileText, Table2, FileCode, File } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AlertDialog } from '@/components/ui/alert-dialog';
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

const STATUS_BORDER: Record<DocumentStatus, string> = {
  PENDING:    'border-l-yellow-400',
  PROCESSING: 'border-l-orange-400',
  COMPLETED:  'border-l-green-500',
  FAILED:     'border-l-red-500',
};

const STATUS_LABELS: Record<DocumentStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  COMPLETED: 'Ready',
  FAILED: 'Failed',
};

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf': return <FileText className="size-3.5 shrink-0 text-red-500" aria-hidden="true" />;
    case 'csv': return <Table2   className="size-3.5 shrink-0 text-green-600" aria-hidden="true" />;
    case 'md':  return <FileCode className="size-3.5 shrink-0 text-purple-500" aria-hidden="true" />;
    default:    return <File     className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />;
  }
}

interface DocumentItemProps {
  doc: Document;
  onDelete: (id: string) => void;
}

function DocumentItemInner({ doc, onDelete }: DocumentItemProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          'group flex items-start justify-between gap-2 border-l-2 px-3 py-2.5 transition-colors hover:bg-muted/50',
          STATUS_BORDER[doc.status],
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {getFileIcon(doc.name)}
            <p
              className="truncate text-sm font-medium leading-tight"
              title={doc.name}
            >
              {doc.name}
            </p>
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border border-current/20 px-2 py-0.5 text-xs font-medium',
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
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 opacity-40 transition-opacity group-hover:opacity-100 focus:opacity-100"
                onClick={() => setConfirmOpen(true)}
              />
            }
          >
            <Trash2 className="size-3.5" />
            <span className="sr-only">Remove {doc.name}</span>
          </TooltipTrigger>
          <TooltipContent>Remove document</TooltipContent>
        </Tooltip>
      </div>

      <AlertDialog
        open={confirmOpen}
        title="Remove document?"
        description={`"${doc.name}" will be permanently removed from this session.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          onDelete(doc.id);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export const DocumentItem = memo(DocumentItemInner);
