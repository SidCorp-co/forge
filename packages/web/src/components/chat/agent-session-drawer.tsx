'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AgentSessionPanel } from './agent-session-panel';

interface AgentSessionDrawerProps {
  sessionId: string;
  projectSlug: string;
  onTogglePin: () => void;
  onClose: () => void;
  onOpenFull?: () => void;
}

export function AgentSessionDrawer({
  sessionId,
  projectSlug,
  onTogglePin,
  onClose,
  onOpenFull,
}: AgentSessionDrawerProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-40"
      role="dialog"
      aria-modal="true"
      aria-label="Agent session"
    >
      <button
        type="button"
        aria-label="Close session drawer"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-on-primary/40 backdrop-blur-sm"
      />
      <div
        ref={drawerRef}
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col border-l border-outline-variant/20 bg-surface shadow-xl outline-none transition-transform duration-150 ease-out"
      >
        <AgentSessionPanel
          sessionId={sessionId}
          projectSlug={projectSlug}
          pinned={false}
          onTogglePin={onTogglePin}
          onClose={onClose}
          onOpenFull={onOpenFull}
        />
      </div>
    </div>,
    document.body,
  );
}
