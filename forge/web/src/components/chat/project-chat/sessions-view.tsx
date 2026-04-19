'use client';

import { Plus, X, CircleDot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SessionList } from '../session-list';
import type { SessionSummary } from './use-chat-sessions';

interface SessionsViewProps {
  sessions: SessionSummary[];
  loadingSessions: boolean;
  onSelect: (session: SessionSummary) => void;
  onNew: () => void;
  onClose: () => void;
  issueContext?: { id: number; title: string };
}

export function SessionsView({ sessions, loadingSessions, onSelect, onNew, onClose, issueContext }: SessionsViewProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Chat Sessions</h3>
        <div className="flex gap-2">
          <Button size="xs" onClick={onNew} className="flex items-center gap-1">
            <Plus className="h-3 w-3" />
            New
          </Button>
          <button onClick={onClose} className="p-2.5 text-outline hover:text-on-surface-variant transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        </div>
        {issueContext && (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-info">
            <CircleDot className="h-3 w-3 shrink-0" />
            <span className="truncate">Context: ISS-{issueContext.id} — {issueContext.title}</span>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <SessionList
          sessions={sessions}
          loading={loadingSessions}
          onSelect={onSelect}
          onNew={onNew}
        />
      </div>
    </div>
  );
}
