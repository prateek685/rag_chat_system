'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpenIcon, XIcon } from 'lucide-react';
import type { Citation } from '@/lib/types';

interface CitationSidePanelProps {
  citations: Citation[];
}

/** Custom event name used to coordinate mutual exclusion across panel instances. */
const PANEL_OPEN_EVENT = 'citation-panel-open';

/**
 * Sources button + right-side panel per message.
 * Rendered via portal directly on <body> — no overlay, no background blur.
 * Focus moves to the Close button on open and returns to the Sources button on close.
 *
 * Broadcasts PANEL_OPEN_EVENT when it opens so sibling instances close themselves,
 * ensuring at most one panel is visible at a time.
 */
export function CitationSidePanel({ citations }: CitationSidePanelProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Track whether the panel has ever been opened — prevents focus from being
  // stolen during initial render when open starts as false.
  const hasOpenedRef = useRef(false);
  // Set to true when a sibling panel displaces this one — suppresses focus
  // return to this panel's trigger (focus already moved to the sibling's trigger).
  const suppressFocusReturnRef = useRef(false);

  useEffect(() => { setMounted(true); }, []);

  // When this panel opens, broadcast to all sibling panels to close.
  useEffect(() => {
    if (!open) return;
    document.dispatchEvent(
      new CustomEvent<{ panelId: string }>(PANEL_OPEN_EVENT, { detail: { panelId } }),
    );
  }, [open, panelId]);

  // Listen for another panel opening and close self without stealing focus back.
  useEffect(() => {
    const handler = (e: Event) => {
      const { panelId: activePanelId } = (e as CustomEvent<{ panelId: string }>).detail;
      if (activePanelId !== panelId && open) {
        suppressFocusReturnRef.current = true;
        setOpen(false);
      }
    };
    document.addEventListener(PANEL_OPEN_EVENT, handler);
    return () => document.removeEventListener(PANEL_OPEN_EVENT, handler);
  }, [open, panelId]);

  // Move focus into the panel when it opens; return to the trigger only after
  // a genuine close (not on initial mount, and not when displaced by a sibling).
  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      suppressFocusReturnRef.current = false;
      closeButtonRef.current?.focus();
    } else if (hasOpenedRef.current && !suppressFocusReturnRef.current) {
      sourcesButtonRef.current?.focus();
    }
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const panel = (
    <div
      role="complementary"
      aria-label="Sources panel"
      className="fixed inset-y-0 right-0 z-50 flex w-[340px] flex-col
                 border-l border-border bg-popover text-popover-foreground shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Sources</h2>
        <button
          ref={closeButtonRef}
          onClick={() => setOpen(false)}
          aria-label="Close sources"
          className="rounded-md p-1 text-muted-foreground
                     hover:bg-muted hover:text-foreground transition-colors"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Source cards */}
      <div className="flex-1 overflow-y-auto space-y-3 px-4 py-3">
        {citations.map((c) => (
          <div
            key={c.number}
            className="flex gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
          >
            <span
              className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center
                         rounded text-[11px] font-bold text-white"
              style={{ background: 'linear-gradient(135deg, oklch(0.35 0.15 220) 0%, oklch(0.58 0.13 220) 100%)' }}
            >
              {c.number}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">
                {c.filename}
                {c.pageNumber !== undefined && (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    · Page {c.pageNumber}
                  </span>
                )}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-4">
                {c.excerpt}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={sourcesButtonRef}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1
                   text-xs font-medium text-muted-foreground
                   hover:bg-muted hover:text-foreground transition-colors"
      >
        <BookOpenIcon className="h-3.5 w-3.5" />
        Sources
      </button>

      {mounted && open && createPortal(panel, document.body)}
    </>
  );
}
