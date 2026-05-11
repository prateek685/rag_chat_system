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
        disabled={isUploading}
        aria-disabled={isUploading}
        aria-busy={isUploading}
        onClick={() => !isUploading && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isUploading) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed p-4 text-center text-sm transition-all duration-200',
          'backdrop-blur-md',
          isDragOver
            ? '[animation:upload-glow_1.5s_ease-in-out_infinite]'
            : 'hover:border-[oklch(0.58_0.13_220_/_50%)]',
          isUploading && 'cursor-not-allowed opacity-70',
        )}
        style={{
          borderColor: isDragOver ? 'oklch(0.58 0.13 220)' : 'var(--glass-upload-border)',
          background: isDragOver ? 'var(--glass-upload-bg-dragover)' : 'var(--glass-upload-bg)',
          boxShadow: isDragOver ? 'var(--glass-upload-shadow-dragover)' : 'var(--glass-upload-shadow)',
        }}
      >
        {isUploading ? (
          <>
            {/* Spinner with ripple ring */}
            <div className="relative flex size-10 items-center justify-center">
              <span className="absolute inline-flex size-full rounded-full opacity-75 [animation:upload-ping_1s_ease-out_infinite]"
                    style={{ backgroundColor: 'oklch(0.58 0.13 220 / 25%)' }} />
              <span
                className="size-5 rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: 'oklch(0.58 0.13 220)', borderTopColor: 'transparent' }}
              />
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-medium text-foreground/80">
                {uploadingCount === 1 ? 'Uploading…' : `Uploading ${uploadingCount} files…`}
              </span>
              <span className="text-xs text-muted-foreground/60">Please wait</span>
            </div>
          </>
        ) : (
          <>
            {/* Gradient icon badge */}
            <div
              className="brand-gradient flex size-11 items-center justify-center rounded-xl"
              style={{ boxShadow: '0 4px 16px oklch(0.35 0.15 220 / 35%)' }}
            >
              <Upload className="size-5 text-white" aria-hidden="true" />
            </div>
            <div className="flex flex-col items-center gap-1">
              <span className="font-medium text-foreground/80">
                {isDragOver ? 'Drop to upload' : 'Drop files or click to browse'}
              </span>
              <span className="text-xs text-muted-foreground/55 tracking-wide">
                .txt · .csv · .md · .pdf · max 10 MB
              </span>
            </div>
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
        <div className="mt-2 space-y-1" role="alert" aria-live="assertive">
          {errors.map((err, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span className="flex-1">{err.message}</span>
            </div>
          ))}
          <button
            type="button"
            onClick={onClearErrors}
            className="flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            <X className="size-3" aria-hidden="true" /> Clear errors
          </button>
        </div>
      )}
    </div>
  );
}
