import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { AgentChatArea } from '@/app/projects/[slug]/agent/components/agent-chat-area';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: () => <div data-testid="chat-messages" />,
}));

vi.mock('@/components/chat/branch-diff-summary', () => ({
  BranchDiffSummary: () => <div data-testid="branch-diff-summary" />,
}));

vi.mock('@/app/projects/[slug]/agent/components/prompt-editor', () => ({
  PromptEditor: () => <div data-testid="prompt-editor" />,
}));

type Props = ComponentProps<typeof AgentChatArea>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    sessionId: null,
    sessionTitle: 'New Agent Chat',
    showSessions: false,
    onShowSessions: vi.fn(),
    messages: [],
    isRunning: false,
    usage: { turns: 0, contextUsed: 0, outputTotal: 0 },
    draftPrompt: null,
    isBuildingPrompt: false,
    editablePrompt: '',
    onEditablePromptChange: vi.fn(),
    onCancelDraft: vi.fn(),
    onStartFromPrompt: vi.fn(),
    viewTab: 'chat',
    setViewTab: vi.fn(),
    showChangesTab: false,
    diff: null,
    diffLoading: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
    isSessionOwner: true,
    connectionState: 'open',
    onReconnect: vi.fn(),
    desktopConnected: true,
    relayTimedOut: false,
    onRetrySend: vi.fn(),
    ...overrides,
  };
}

describe('AgentChatArea — runner offline UX', () => {
  it('Layer 1: shows the no-runner banner and disables send when desktop is offline', () => {
    render(<AgentChatArea {...makeProps({ desktopConnected: false })} />);

    expect(screen.getByTestId('no-runner-banner')).toBeInTheDocument();
    const sendBtn = screen.getByRole('button', { name: /send message/i });
    expect(sendBtn).toBeDisabled();
    expect(sendBtn).toHaveAttribute(
      'title',
      'No runner online — install Forge desktop or check device status',
    );
  });

  it('Layer 1: banner clears and send re-enables once the runner connects', () => {
    const { rerender } = render(
      <AgentChatArea {...makeProps({ desktopConnected: false })} />,
    );
    expect(screen.getByTestId('no-runner-banner')).toBeInTheDocument();

    rerender(<AgentChatArea {...makeProps({ desktopConnected: true })} />);
    expect(screen.queryByTestId('no-runner-banner')).not.toBeInTheDocument();
    const sendBtn = screen.getByRole('button', { name: /send message/i });
    expect(sendBtn).not.toHaveAttribute('title');
  });

  it('Layer 2: shows the timeout bubble and fires onRetrySend when Retry is clicked', () => {
    const onRetrySend = vi.fn();
    render(
      <AgentChatArea
        {...makeProps({ relayTimedOut: true, onRetrySend })}
      />,
    );

    expect(screen.getByTestId('relay-timeout-bubble')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetrySend).toHaveBeenCalledTimes(1);
  });
});
