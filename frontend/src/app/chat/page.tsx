'use client';

import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { ChatWindow } from '@/components/chat/ChatWindow';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSession } from '@/hooks/useSession';
import { useDocuments } from '@/hooks/useDocuments';
import { useChat } from '@/hooks/useChat';
import { readStorage, writeStorage, THEME_KEY } from '@/lib/storage';

export default function ChatPage() {
  // Single persistent session UUID — used as x-session-id for all API calls.
  // Documents and messages are scoped to this session on the backend.
  const sessionId = useSession();

  const {
    documents,
    uploadingCount,
    uploadErrors,
    clearUploadErrors,
    uploadFiles,
    deleteDocument,
    hasReadyDocs,
  } = useDocuments(sessionId);

  const {
    messages,
    isStreaming,
    streamError,
    clearStreamError,
    sendMessage,
    stopStreaming,
    retryLast,
    submitFeedback,
  } = useChat(sessionId);

  const [isDark, setIsDark] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const stored = readStorage<string>(THEME_KEY, '');
    if (stored === 'dark') {
      setIsDark(true);
    } else if (stored === 'light') {
      setIsDark(false);
      document.documentElement.classList.remove('dark');
    } else {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setIsDark(systemDark);
    }
  }, []);

  function toggleDark() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    writeStorage(THEME_KEY, next ? 'dark' : 'light');
  }

  const sidebarProps = {
    documents,
    uploadingCount,
    uploadErrors,
    onClearErrors: clearUploadErrors,
    onDelete: deleteDocument,
  };

  return (
    <TooltipProvider>
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
        <Header
          isDark={isDark}
          onToggleDark={toggleDark}
          onOpenSidebar={() => setSidebarOpen(true)}
        />

        {streamError && (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-800/50 dark:bg-amber-900/20">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              <p className="text-sm text-amber-800 dark:text-amber-300">
                {streamError}
              </p>
              <button
                type="button"
                onClick={clearStreamError}
                className="shrink-0 text-xs text-amber-700 underline hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Desktop sidebar */}
          <div className="hidden md:flex">
            <Sidebar {...sidebarProps} onUpload={uploadFiles} />
          </div>

          {/* Mobile sidebar in Sheet */}
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" className="w-72 p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">Documents</SheetTitle>
              <Sidebar
                {...sidebarProps}
                onUpload={(files) => {
                  uploadFiles(files);
                  setSidebarOpen(false);
                }}
              />
            </SheetContent>
          </Sheet>

          {/* Main chat area */}
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ChatWindow
              messages={messages}
              isStreaming={isStreaming}
              onFeedback={submitFeedback}
              onRetry={retryLast}
            />
            <ChatInput
              onSend={sendMessage}
              onStop={stopStreaming}
              isStreaming={isStreaming}
              hasReadyDocs={hasReadyDocs}
            />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
