/**
 * Behavioural tests for ChatWindow.
 *
 * Covers:
 *  1. Empty state — 3-step onboarding guide is shown when messages === [].
 *  2. Message list — bubbles render when messages are present.
 *  3. Accessibility — aria-live region exists on the scroll container.
 *  4. Streaming cursor — only the last message receives isStreaming=true.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ChatWindow } from '../ChatWindow';
import type { Message } from '@/lib/types';

jest.mock('../MessageBubble', () => ({
  MessageBubble: ({
    message,
    isStreaming,
  }: {
    message: Message;
    isStreaming: boolean;
  }) => (
    <div data-testid="message-bubble" data-role={message.role} data-streaming={String(isStreaming)}>
      {message.content}
    </div>
  ),
}));

const noop = () => {};
const noopFeedback = (_traceId: string, _score: 1 | -1 | 0) => {};

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `${role}-${Math.random()}`,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

// ─── Empty state ───────────────────────────────────────────────────────────────

describe('ChatWindow — empty state', () => {
  it('shows the "Start a conversation" heading', () => {
    render(
      <ChatWindow messages={[]} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  });

  it('shows all three step labels', () => {
    render(
      <ChatWindow messages={[]} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.getByText('Upload a file')).toBeInTheDocument();
    expect(screen.getByText('Wait for processing')).toBeInTheDocument();
    expect(screen.getByText('Ask questions')).toBeInTheDocument();
  });

  it('shows all three step descriptions', () => {
    render(
      <ChatWindow messages={[]} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.getByText('PDF, CSV, TXT, or Markdown')).toBeInTheDocument();
    expect(screen.getByText('Usually takes a few seconds')).toBeInTheDocument();
    expect(screen.getByText('About anything in your documents')).toBeInTheDocument();
  });

  it('does not render any message bubbles in the empty state', () => {
    render(
      <ChatWindow messages={[]} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
  });
});

// ─── Message list ──────────────────────────────────────────────────────────────

describe('ChatWindow — message list', () => {
  it('renders one bubble per message', () => {
    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
    ];
    render(
      <ChatWindow messages={messages} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.getAllByTestId('message-bubble')).toHaveLength(2);
  });

  it('renders message content correctly', () => {
    const messages = [makeMessage('user', 'What is RAG?')];
    render(
      <ChatWindow messages={messages} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.getByText('What is RAG?')).toBeInTheDocument();
  });

  it('passes isStreaming=true only to the last message while streaming', () => {
    const messages = [
      makeMessage('user', 'Question'),
      makeMessage('assistant', 'Partial…'),
    ];
    render(
      <ChatWindow messages={messages} isStreaming={true} onFeedback={noopFeedback} onRetry={noop} />,
    );
    const bubbles = screen.getAllByTestId('message-bubble');
    expect(bubbles[0]).toHaveAttribute('data-streaming', 'false');
    expect(bubbles[1]).toHaveAttribute('data-streaming', 'true');
  });

  it('does not show the empty state when messages are present', () => {
    const messages = [makeMessage('user', 'Hello')];
    render(
      <ChatWindow messages={messages} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument();
  });
});

// ─── Accessibility ─────────────────────────────────────────────────────────────

describe('ChatWindow — accessibility', () => {
  it('scroll container has aria-live="polite" when messages are present', () => {
    const messages = [makeMessage('user', 'Hello')];
    const { container } = render(
      <ChatWindow messages={messages} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('scroll container has aria-label="Chat messages"', () => {
    const messages = [makeMessage('assistant', 'Hi')];
    const { container } = render(
      <ChatWindow messages={messages} isStreaming={false} onFeedback={noopFeedback} onRetry={noop} />,
    );
    expect(container.querySelector('[aria-label="Chat messages"]')).not.toBeNull();
  });
});
