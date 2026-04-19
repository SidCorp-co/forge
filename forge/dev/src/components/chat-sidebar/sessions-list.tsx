'use client';

import { Button, PanelHeader, CloseButton, EmptyState } from "@/components/ui";
import { relativeTime } from "./helpers";

export interface SessionSummary {
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionsListProps {
  sessions: SessionSummary[];
  loading: boolean;
  onSelectSession: (session: SessionSummary) => void;
  onNewChat: () => void;
  onClose: () => void;
}

export function SessionsList({ sessions, loading, onSelectSession, onNewChat, onClose }: SessionsListProps) {
  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        className="px-4"
        left={<h3 className="text-sm font-semibold text-gray-900">Chat Sessions</h3>}
        right={
          <div className="flex gap-2">
            <Button size="sm" onClick={onNewChat}>+ New</Button>
            <CloseButton onClick={onClose} />
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No chat sessions yet"
              action={<Button size="md" onClick={onNewChat}>Start a conversation</Button>}
            />
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {sessions.map((s) => (
              <button key={s.documentId} onClick={() => onSelectSession(s)} className="w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors">
                <p className="text-sm font-medium text-gray-900 truncate">{s.title || "Untitled"}</p>
                <p className="text-xs text-gray-400 mt-0.5">{relativeTime(s.updatedAt || s.createdAt)}</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
