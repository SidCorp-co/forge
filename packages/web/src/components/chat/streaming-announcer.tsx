'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatMessageData } from './chat-message/chat-message-types';

interface StreamingAnnouncerProps {
  messages: ChatMessageData[];
}

const ANNOUNCE_INTERVAL_MS = 800;
const MIN_DELTA_CHARS = 24;

export function StreamingAnnouncer({ messages }: StreamingAnnouncerProps) {
  const [announcement, setAnnouncement] = useState('');

  const announcedTurnIdRef = useRef<string | null>(null);
  const announcedLengthRef = useRef(0);
  const lastAnnouncedAtRef = useRef(0);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      // Seed the offset so historical content (including WS replay on reconnect)
      // is never announced on the initial paint.
      const lastStreaming = [...messages].reverse().find(
        (m) => m.role === 'assistant' && m.isStreaming,
      );
      if (lastStreaming) {
        announcedTurnIdRef.current = lastStreaming.id;
        announcedLengthRef.current = lastStreaming.content.length;
      }
      return;
    }

    const streaming = [...messages].reverse().find(
      (m) => m.role === 'assistant' && m.isStreaming,
    );
    if (!streaming) return;

    if (announcedTurnIdRef.current !== streaming.id) {
      announcedTurnIdRef.current = streaming.id;
      announcedLengthRef.current = 0;
      lastAnnouncedAtRef.current = 0;
    }

    const content = streaming.content ?? '';
    // WS reconnect-replay can shrink content (server re-sends from start).
    // Treat shrink as "already announced" — don't re-announce the prefix.
    if (content.length < announcedLengthRef.current) {
      announcedLengthRef.current = content.length;
      return;
    }

    const delta = content.slice(announcedLengthRef.current);
    if (delta.trim().length < MIN_DELTA_CHARS) return;

    const now = Date.now();
    if (now - lastAnnouncedAtRef.current < ANNOUNCE_INTERVAL_MS) return;

    lastAnnouncedAtRef.current = now;
    announcedLengthRef.current = content.length;
    setAnnouncement(delta.trim());
  }, [messages]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="chat-streaming-announcer"
    >
      {announcement}
    </div>
  );
}
