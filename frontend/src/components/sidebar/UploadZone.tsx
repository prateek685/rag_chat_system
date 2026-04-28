'use client';

import { useRef, useState } from 'react';
import { Upload, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface UploadError {
  filename: string;
  message: string;
}

interface UploadZoneProps {
  uploadingCount: number;
  errors: UploadError[];
  onClearErrors: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
}

export function UploadZone({
  uploadingCount,
  errors,
  onClearErrors,
  onFilesSelected,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const isUploading = uploadingCount > 0;

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) onFilesSelected(e.dataTransfer.files);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) {
      onFilesSelected(e.target.files);
      // reset so same file can trigger onChange again after an error
      e.target.value = '';
    }
  }

  return (
    <div className="p-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex w-full flex-col items-center gap-1.5 rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors',
          isDragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/40 hover:bg-muted/50',
          isUploading && 'cursor-not-allowed opacity-70',
        )}
      >
        {isUploading ? (
          <>
            <span className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-muted-foreground">
              {uploadingCount === 1
                ? 'Uploading…'
                : `Uploading ${uploadingCount} files…`}
            </span>
          </>
        ) : (
          <>
            <Upload className="size-5 text-muted-foreground" />
            <span className="text-muted-foreground">
              {isDragOver ? 'Drop to upload' : 'Drop files or click to browse'}
            </span>
            <span className="text-xs text-muted-foreground/60">
              .txt .csv .md .pdf · max 10 MB
            </span>
          </>
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".txt,.csv,.md,.pdf"
        className="hidden"
        onChange={handleChange}
      />

      {errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {errors.map((err, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span className="flex-1">{err.message}</span>
            </div>
          ))}
          <button
            type="button"
            onClick={onClearErrors}
            className="flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            <X className="size-3" /> Clear errors
          </button>
        </div>
      )}
    </div>
  );
}
