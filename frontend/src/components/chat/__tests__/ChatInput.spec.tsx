/**
 * Behavioural tests for ChatInput.
 *
 * Covers:
 *  1. Rendering states — send vs stop button, disabled when no ready docs.
 *  2. Character counter — visible when typing, hidden when empty, red when over limit.
 *  3. Send behaviour — Enter key, click button, clears input after send.
 *  4. Over-limit guard — send is blocked when message exceeds MAX_CHARS.
 *  5. Shift+Enter does NOT send.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatInput } from '../ChatInput';

const MAX_CHARS = 2000;

const defaultProps = {
  onSend: jest.fn(),
  onStop: jest.fn(),
  isStreaming: false,
  hasReadyDocs: true,
};

beforeEach(() => jest.clearAllMocks());

// ─── Rendering states ──────────────────────────────────────────────────────────

describe('ChatInput — rendering states', () => {
  it('renders the send button when not streaming', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  });

  it('renders the stop button when streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    expect(screen.getByRole('button', { name: /stop generating/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send message/i })).not.toBeInTheDocument();
  });

  it('shows the "upload" placeholder when no docs are ready', () => {
    render(<ChatInput {...defaultProps} hasReadyDocs={false} />);
    expect(screen.getByPlaceholderText(/upload a document/i)).toBeInTheDocument();
  });

  it('shows the "ask" placeholder when docs are ready', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByPlaceholderText(/ask about your documents/i)).toBeInTheDocument();
  });

  it('textarea is disabled when no ready docs and not streaming', () => {
    render(<ChatInput {...defaultProps} hasReadyDocs={false} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('textarea is enabled during streaming even without ready docs', () => {
    // isStreaming=true means we are mid-response — textarea should not be disabled
    render(<ChatInput {...defaultProps} hasReadyDocs={false} isStreaming={true} />);
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });
});

// ─── Character counter ─────────────────────────────────────────────────────────

describe('ChatInput — character counter', () => {
  it('counter is hidden when the input is empty', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.queryByText(new RegExp(`/${MAX_CHARS}`))).not.toBeInTheDocument();
  });

  it('counter appears and shows correct count when typing', () => {
    render(<ChatInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
    expect(screen.getByText(`5/${MAX_CHARS}`)).toBeInTheDocument();
  });

  it('counter disappears when input is cleared', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hi' } });
    fireEvent.change(textarea, { target: { value: '' } });
    expect(screen.queryByText(new RegExp(`/${MAX_CHARS}`))).not.toBeInTheDocument();
  });

  it('counter has text-destructive class when over the limit', () => {
    render(<ChatInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'a'.repeat(MAX_CHARS + 1) },
    });
    const counter = screen.getByText(`${MAX_CHARS + 1}/${MAX_CHARS}`);
    expect(counter).toHaveClass('text-destructive');
  });

  it('counter does NOT have text-destructive class when at the limit', () => {
    render(<ChatInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'a'.repeat(MAX_CHARS) },
    });
    const counter = screen.getByText(`${MAX_CHARS}/${MAX_CHARS}`);
    expect(counter).not.toHaveClass('text-destructive');
  });
});

// ─── Send behaviour ────────────────────────────────────────────────────────────

describe('ChatInput — send behaviour', () => {
  it('calls onSend with trimmed text when Enter is pressed', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '  Hello  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.onSend).toHaveBeenCalledWith('Hello');
  });

  it('calls onSend when the send button is clicked', () => {
    render(<ChatInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Test message' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    expect(defaultProps.onSend).toHaveBeenCalledWith('Test message');
  });

  it('clears the input after send', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(textarea).toHaveValue('');
  });

  it('does NOT call onSend when Shift+Enter is pressed', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(defaultProps.onSend).not.toHaveBeenCalled();
  });

  it('does NOT call onSend for whitespace-only input', () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.onSend).not.toHaveBeenCalled();
  });

  it('does NOT call onSend while streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    // No send button while streaming — only stop button
    expect(screen.queryByRole('button', { name: /send message/i })).not.toBeInTheDocument();
    expect(defaultProps.onSend).not.toHaveBeenCalled();
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });

  it('send button is disabled when message is over the character limit', () => {
    render(<ChatInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'a'.repeat(MAX_CHARS + 1) },
    });
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });
});

// ─── Stop behaviour ────────────────────────────────────────────────────────────

describe('ChatInput — stop behaviour', () => {
  it('calls onStop when the stop button is clicked', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    fireEvent.click(screen.getByRole('button', { name: /stop generating/i }));
    expect(defaultProps.onStop).toHaveBeenCalledTimes(1);
  });
});
