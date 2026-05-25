'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useJob } from '../hooks/use-jobs';
import { useJobPrompt } from '../hooks/use-job-prompt';
import {
  PromptInspectorTabs,
  type InspectorTab,
} from './PromptInspectorTabs';

interface Props {
  jobId: string;
  onClose: () => void;
}

export function PromptInspectorDrawer({ jobId, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<InspectorTab>('prompt');
  const promptQuery = useJobPrompt(jobId);
  const jobQuery = useJob(jobId);

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
      aria-label="Prompt inspector"
    >
      <button
        type="button"
        aria-label="Close inspector overlay"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-on-primary/40 backdrop-blur-sm"
      />
      <div
        ref={drawerRef}
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col border-l border-outline-variant/20 bg-surface shadow-xl outline-none"
      >
        <PromptInspectorTabs
          jobId={jobId}
          tab={tab}
          onTabChange={setTab}
          promptQuery={promptQuery}
          jobQuery={jobQuery}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}
