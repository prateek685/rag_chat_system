'use client';

import { ThumbsUp, ThumbsDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface FeedbackBarProps {
  traceId: string | undefined;
  feedback: 1 | -1 | undefined;
  isLast: boolean;
  onFeedback: (traceId: string, score: 1 | -1 | 0) => void;
  onRetry: () => void;
}

export function FeedbackBar({
  traceId,
  feedback,
  isLast,
  onFeedback,
  onRetry,
}: FeedbackBarProps) {
  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      {traceId && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    traceId && onFeedback(traceId, feedback === 1 ? 0 : 1)
                  }
                  className={cn(
                    feedback !== undefined && feedback !== 1 && 'opacity-30',
                  )}
                  style={feedback === 1 ? { color: 'oklch(0.58 0.13 220)' } : undefined}
                />
              }
            >
              <ThumbsUp className="size-3.5" />
              <span className="sr-only">Good response</span>
            </TooltipTrigger>
            <TooltipContent>Good response</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    traceId && onFeedback(traceId, feedback === -1 ? 0 : -1)
                  }
                  className={cn(
                    feedback !== undefined && feedback !== -1 && 'opacity-30',
                  )}
                  style={feedback === -1 ? { color: 'oklch(0.58 0.13 220)' } : undefined}
                />
              }
            >
              <ThumbsDown className="size-3.5" />
              <span className="sr-only">Bad response</span>
            </TooltipTrigger>
            <TooltipContent>Bad response</TooltipContent>
          </Tooltip>
        </>
      )}

      {isLast && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onRetry}
                className="text-muted-foreground"
              />
            }
          >
            <RotateCcw className="size-3.5" />
            <span className="sr-only">Retry response</span>
          </TooltipTrigger>
          <TooltipContent>Retry response</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
