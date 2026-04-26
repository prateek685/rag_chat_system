'use client';

import { Menu, Moon, Sun, MessageSquare } from 'lucide-react';
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
}

export function Header({ isDark, onToggleDark, onOpenSidebar }: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background/95 px-4 backdrop-blur-sm">
      <div className="flex items-center gap-2">
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
        <div className="flex items-center gap-2">
          <MessageSquare className="size-5 text-primary" />
          <span className="text-base font-semibold">RAG Chat</span>
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
