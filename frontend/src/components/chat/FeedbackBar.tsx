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
  onFeedback: (traceId: string, score: 1 | -1) => void;
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
                  onClick={() => traceId && onFeedback(traceId, 1)}
                  className={cn(
                    feedback === 1 && 'text-blue-500 hover:text-blue-500',
                    feedback !== undefined && feedback !== 1 && 'opacity-30',
                  )}
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
                  onClick={() => traceId && onFeedback(traceId, -1)}
                  className={cn(
                    feedback === -1 && 'text-destructive hover:text-destructive',
                    feedback !== undefined && feedback !== -1 && 'opacity-30',
                  )}
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
