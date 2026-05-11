import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { StreamingAnnouncer } from '@/components/chat/streaming-announcer';
import type { ChatMessageData } from '@/components/chat/chat-message/chat-message-types';

function makeMsg(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: 't1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    ...overrides,
  };
}

function getAnnouncerText(container: HTMLElement): string {
  const node = container.querySelector('[data-testid="chat-streaming-announcer"]');
  return node?.textContent ?? '';
}

describe('StreamingAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces streaming deltas past the throttle interval and char threshold', () => {
    const initial: ChatMessageData[] = [
      makeMsg({ id: 't1', isStreaming: true, content: 'Hi.' }),
    ];
    const { container, rerender } = render(<StreamingAnnouncer messages={initial} />);

    // Initial paint seeds offset; nothing announced.
    expect(getAnnouncerText(container)).toBe('');

    // Advance past throttle, then deliver a delta past MIN_DELTA_CHARS (24+).
    act(() => {
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    });
    const next: ChatMessageData[] = [
      makeMsg({
        id: 't1',
        isStreaming: true,
        content: 'Hi. This is a longer streamed assistant reply.',
      }),
    ];
    rerender(<StreamingAnnouncer messages={next} />);

    expect(getAnnouncerText(container)).toContain('This is a longer streamed assistant reply.');
  });

  it('does not announce historical messages on first paint', () => {
    const history: ChatMessageData[] = [
      makeMsg({ id: 'h1', role: 'assistant', content: 'Past reply one.', isStreaming: false }),
      makeMsg({ id: 'h2', role: 'assistant', content: 'Past reply two.', isStreaming: false }),
      makeMsg({
        id: 'h3',
        role: 'assistant',
        content: 'A long resumed streaming reply that exceeds the delta threshold.',
        isStreaming: true,
      }),
    ];
    const { container } = render(<StreamingAnnouncer messages={history} />);

    expect(getAnnouncerText(container)).toBe('');
  });

  it('does not double-announce when WS replay shrinks content back', () => {
    const t0: ChatMessageData[] = [
      makeMsg({ id: 't1', isStreaming: true, content: '' }),
    ];
    const { container, rerender } = render(<StreamingAnnouncer messages={t0} />);

    act(() => {
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    });
    const fullContent = 'Hello world this is a long enough streamed reply.';
    rerender(
      <StreamingAnnouncer
        messages={[makeMsg({ id: 't1', isStreaming: true, content: fullContent })]}
      />,
    );
    const firstAnnouncement = getAnnouncerText(container);
    expect(firstAnnouncement).toContain('Hello world this is a long enough streamed reply.');

    // Simulate WS reconnect replay: server re-streams from start.
    rerender(
      <StreamingAnnouncer
        messages={[makeMsg({ id: 't1', isStreaming: true, content: 'Hello' })]}
      />,
    );
    expect(getAnnouncerText(container)).toBe(firstAnnouncement);

    // Replay catches back up to the same content.
    rerender(
      <StreamingAnnouncer
        messages={[makeMsg({ id: 't1', isStreaming: true, content: fullContent })]}
      />,
    );
    expect(getAnnouncerText(container)).toBe(firstAnnouncement);
  });
});
