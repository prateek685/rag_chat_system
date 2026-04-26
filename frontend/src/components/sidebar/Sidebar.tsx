'use client';

import { FileText } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
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
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-muted/20">
      <div className="shrink-0 px-4 pt-3 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          Documents
        </h2>
      </div>

      <UploadZone
        uploadingCount={uploadingCount}
        errors={uploadErrors}
        onClearErrors={onClearErrors}
        onFilesSelected={onUpload}
      />

      <Separator />

      <ScrollArea className="flex-1">
        {documents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <FileText className="size-9 text-muted-foreground/30" />
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
