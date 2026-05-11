'use client';

import { PanelLeft, PanelLeftClose, Menu, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface HeaderProps {
  isDark: boolean;
  onToggleDark: () => void;
  onOpenSidebar: () => void;
  desktopSidebarOpen: boolean;
  onToggleDesktopSidebar: () => void;
}

export function Header({
  isDark,
  onToggleDark,
  onOpenSidebar,
  desktopSidebarOpen,
  onToggleDesktopSidebar,
}: HeaderProps) {
  return (
    <header className="relative flex h-14 shrink-0 items-center justify-between bg-background px-4">
      {/* Teal gradient accent line at the bottom edge */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, oklch(0.58 0.13 220) 50%, transparent 100%)',
        }}
        aria-hidden="true"
      />

      <div className="flex items-center gap-1.5">
        {/* Mobile menu button — opens Sheet drawer */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={onOpenSidebar}
              />
            }
          >
            <Menu className="size-5" />
            <span className="sr-only">Open sidebar</span>
          </TooltipTrigger>
          <TooltipContent>Documents</TooltipContent>
        </Tooltip>

        {/* Desktop sidebar toggle — collapses/expands the inline sidebar */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex"
                onClick={onToggleDesktopSidebar}
                aria-expanded={desktopSidebarOpen}
                aria-controls="desktop-sidebar"
              />
            }
          >
            {desktopSidebarOpen ? (
              <PanelLeftClose className="size-5" />
            ) : (
              <PanelLeft className="size-5" />
            )}
            <span className="sr-only">
              {desktopSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {desktopSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          </TooltipContent>
        </Tooltip>

        <div className="flex items-center gap-2.5">
          {/* Gradient logo badge */}
          <div className="brand-gradient flex size-7 items-center justify-center rounded-lg shadow-sm">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
              aria-hidden="true"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <span className="text-base font-semibold tracking-tight text-foreground">
            RAG Chat
          </span>
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon" onClick={onToggleDark} />}
        >
          {isDark ? (
            <Sun className="size-5" />
          ) : (
            <Moon className="size-5" />
          )}
          <span className="sr-only">
            {isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          </span>
        </TooltipTrigger>
        <TooltipContent>{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
      </Tooltip>
    </header>
  );
}
