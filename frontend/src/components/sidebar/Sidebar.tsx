'use client';

import { Upload } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Document } from '@/lib/types';
import { UploadZone, type UploadError } from './UploadZone';
import { DocumentItem } from './DocumentItem';

interface SidebarProps {
  documents: Document[];
  uploadingCount: number;
  uploadErrors: UploadError[];
  onClearErrors: () => void;
  onUpload: (files: FileList | File[]) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({
  documents,
  uploadingCount,
  uploadErrors,
  onClearErrors,
  onUpload,
  onDelete,
}: SidebarProps) {
  const readyCount = documents.filter((d) => d.status === 'COMPLETED').length;
  const totalCount = documents.length;

  return (
    <aside
      className="relative flex h-full w-72 shrink-0 flex-col overflow-hidden"
      style={{
        background: 'var(--glass-sidebar-bg)',
        backdropFilter: 'blur(24px) saturate(180%)',
        borderRight: '1px solid var(--glass-sidebar-border-color)',
        boxShadow: 'var(--glass-sidebar-shadow)',
      }}
    >
      {/* Teal gradient wash — gives the glass its colour character */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: 'var(--glass-sidebar-wash)' }}
      />

      {/* Header */}
      <div className="relative z-10 flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-3.5">
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Documents
        </h2>
        {totalCount > 0 && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
            style={{
              backgroundColor: 'var(--sidebar-badge-bg)',
              color: 'var(--sidebar-badge-color)',
            }}
            title={`${readyCount} of ${totalCount} ready`}
          >
            {readyCount}/{totalCount}
          </span>
        )}
      </div>

      {/* Teal gradient separator below header */}
      <div
        aria-hidden="true"
        className="pointer-events-none relative z-10 mx-3 h-px shrink-0"
        style={{ background: 'var(--glass-sep-strong)' }}
      />

      <div className="relative z-10">
        <UploadZone
          uploadingCount={uploadingCount}
          errors={uploadErrors}
          onClearErrors={onClearErrors}
          onFilesSelected={onUpload}
        />
      </div>

      {/* Teal gradient separator above document list */}
      <div
        aria-hidden="true"
        className="pointer-events-none relative z-10 mx-3 h-px shrink-0"
        style={{ background: 'var(--glass-sep-subtle)' }}
      />

      <ScrollArea className="relative z-10 flex-1">
        {documents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <div
              className="brand-gradient flex size-12 items-center justify-center rounded-full"
              style={{ boxShadow: '0 4px 16px oklch(0.35 0.15 220 / 25%)' }}
            >
              <Upload className="size-5 text-white" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              No documents yet
            </p>
            <p className="text-xs text-muted-foreground/60">
              Upload a file above to get started
            </p>
          </div>
        ) : (
          <div className="py-1">
            {documents.map((doc) => (
              <DocumentItem key={doc.id} doc={doc} onDelete={onDelete} />
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}
