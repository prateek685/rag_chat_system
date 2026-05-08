'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AlertDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}

/**
 * Glass-morphism confirmation dialog with full keyboard and focus management.
 * Cancel button receives focus by default — Enter/Space safely dismisses.
 * Escape key also cancels. Focus is trapped within the dialog while open.
 */
export function AlertDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  destructive = false,
}: AlertDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Tab') {
        const focusable = [cancelRef.current, confirmRef.current].filter(Boolean) as HTMLElement[];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
      aria-labelledby="alert-dialog-title"
      aria-describedby={description ? 'alert-dialog-description' : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/45"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Glass card */}
      <div
        className={cn(
          'relative z-10 w-full max-w-sm rounded-2xl',
          'bg-card/95 backdrop-blur-xl',
          'shadow-[0_8px_40px_oklch(0.35_0.15_220_/_25%)]',
          'overflow-hidden',
        )}
      >
        {/* Teal top accent strip */}
        <div
          className="h-1 w-full"
          style={{
            background: 'linear-gradient(90deg, oklch(0.35 0.15 220) 0%, oklch(0.58 0.13 220) 100%)',
          }}
          aria-hidden="true"
        />

        <div className="p-6">
          {/* Icon + title row */}
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full',
                destructive ? 'bg-red-100 dark:bg-red-950/40' : 'bg-[oklch(0.94_0.04_220)]',
              )}
            >
              {destructive ? (
                <Trash2 className="size-4 text-destructive" aria-hidden="true" />
              ) : (
                <Info
                  className="size-4"
                  style={{ color: 'oklch(0.58 0.13 220)' }}
                  aria-hidden="true"
                />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h2
                id="alert-dialog-title"
                className="text-base font-semibold text-foreground"
              >
                {title}
              </h2>

              {description && (
                <p
                  id="alert-dialog-description"
                  className="mt-1.5 text-sm text-muted-foreground leading-relaxed"
                >
                  {description}
                </p>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-5 border-t border-border/60" aria-hidden="true" />

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              className={cn(
                'rounded-xl px-4 py-2 text-sm font-medium transition-colors',
                'bg-muted hover:bg-muted/70 text-foreground',
                'border border-border/60',
              )}
            >
              {cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              className={cn(
                'rounded-xl px-4 py-2 text-sm font-medium transition-all',
                destructive
                  ? 'bg-destructive text-white hover:bg-destructive/90 shadow-[0_2px_8px_oklch(0.577_0.245_27.325_/_30%)]'
                  : 'text-white hover:opacity-90',
              )}
              style={
                !destructive
                  ? {
                      background:
                        'linear-gradient(135deg, oklch(0.35 0.15 220) 0%, oklch(0.58 0.13 220) 100%)',
                      boxShadow: '0 2px 8px oklch(0.35 0.15 220 / 30%)',
                    }
                  : undefined
              }
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
