'use client';

import { useState } from 'react';
import { X, ThumbsUp, ThumbsDown, Flag, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/relative-time';
import { useChatLog, useUpdateChatLogRating } from '@/features/chat-log/hooks/use-chat-logs';
import type { QaRating } from '@/features/chat-log/types';

interface ChatLogSidePanelProps {
  logId: string;
  onClose: () => void;
  onOpenReplay: (logId: string) => void;
}

export function ChatLogSidePanel({ logId, onClose, onOpenReplay }: ChatLogSidePanelProps) {
  const { data: log, isLoading } = useChatLog(logId);
  const updateRating = useUpdateChatLogRating();
  const [notes, setNotes] = useState('');
  const [notesEditing, setNotesEditing] = useState(false);

  function handleRate(rating: QaRating) {
    if (!log) return;
    updateRating.mutate({ id: log.documentId, qaRating: rating, qaNotes: notes || log.qaNotes || undefined });
  }

  function handleSaveNotes() {
    if (!log) return;
    updateRating.mutate({ id: log.documentId, qaRating: log.qaRating ?? null, qaNotes: notes });
    setNotesEditing(false);
  }

  return (
    <div className="flex h-full flex-col border-l bg-surface-container-low">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-on-surface">Chat Log</h3>
        <button
          onClick={onClose}
          className="rounded p-1 text-outline hover:bg-surface-container-high hover:text-on-surface-variant"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-outline" />
        </div>
      ) : !log ? (
        <p className="p-4 text-sm text-outline">Not found.</p>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Meta */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-primary-fixed">
            <span>{relativeTime(log.createdAt)}</span>
            {log.queryIntent && (
              <span className="font-medium text-on-surface-variant capitalize">{log.queryIntent}</span>
            )}
            <span>{log.source}</span>
            {log.durationMs != null && (
              <span>
                {log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
            {log.iterations > 1 && <span>{log.iterations} iterations</span>}
          </div>

          {/* Query */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-outline">Query</p>
            <p className="text-sm text-on-surface whitespace-pre-wrap">{log.query}</p>
          </div>

          {/* Reply */}
          {log.reply && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-outline">Reply</p>
              <p className="text-sm text-on-surface-variant whitespace-pre-wrap line-clamp-10">{log.reply}</p>
            </div>
          )}

          {/* Stats row */}
          {(log.usage || log.ragContext) && (
            <div className="rounded-lg bg-surface-container-low p-3 text-xs space-y-1">
              {log.usage && (
                <div className="flex gap-4 text-primary-fixed">
                  {log.usage.input_tokens != null && (
                    <span>Input: {log.usage.input_tokens} tok</span>
                  )}
                  {log.usage.output_tokens != null && (
                    <span>Output: {log.usage.output_tokens} tok</span>
                  )}
                </div>
              )}
              {log.ragContext && log.ragContext.length > 0 && (
                <span className="text-primary-fixed">RAG hits: {log.ragContext.length}</span>
              )}
            </div>
          )}

          {/* QA Rating */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-outline">QA Rating</p>
            <div className="flex gap-2">
              <button
                onClick={() => handleRate('good')}
                disabled={updateRating.isPending}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  log.qaRating === 'good'
                    ? 'border-success bg-success-surface text-success'
                    : 'border-outline-variant/30 text-primary-fixed hover:border-success hover:bg-success-surface hover:text-success'
                )}
              >
                <ThumbsUp className="h-3.5 w-3.5" />
                Good
              </button>
              <button
                onClick={() => handleRate('bad')}
                disabled={updateRating.isPending}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  log.qaRating === 'bad'
                    ? 'border-danger bg-danger-surface text-danger'
                    : 'border-outline-variant/30 text-primary-fixed hover:border-danger/30 hover:bg-danger-surface hover:text-danger'
                )}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                Bad
              </button>
              <button
                onClick={() => handleRate('flagged')}
                disabled={updateRating.isPending}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  log.qaRating === 'flagged'
                    ? 'border-warning bg-warning-dim/10 text-warning'
                    : 'border-outline-variant/30 text-primary-fixed hover:border-warning hover:bg-warning-dim/10 hover:text-warning'
                )}
              >
                <Flag className="h-3.5 w-3.5" />
                Flag
              </button>
            </div>
          </div>

          {/* QA Notes */}
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-outline">Notes</p>
            {notesEditing ? (
              <div className="space-y-2">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded border border-outline-variant/30 p-2 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
                  placeholder="Add QA notes..."
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveNotes}
                    className="rounded bg-surface px-3 py-1 text-xs text-on-surface hover:bg-surface-container-high"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setNotesEditing(false)}
                    className="rounded px-3 py-1 text-xs text-primary-fixed hover:bg-surface-container-high"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setNotes(log.qaNotes ?? '');
                  setNotesEditing(true);
                }}
                className="w-full rounded border border-dashed border-outline-variant/30 p-2 text-left text-xs text-outline hover:border-outline-variant hover:text-on-surface-variant"
              >
                {log.qaNotes || 'Add notes...'}
              </button>
            )}
          </div>

          {/* Full replay button */}
          <button
            onClick={() => onOpenReplay(log.documentId)}
            className="w-full rounded-md border border-outline-variant/30 px-4 py-2 text-xs font-medium text-on-surface-variant hover:bg-surface-container-low"
          >
            View Full Replay
          </button>
        </div>
      )}
    </div>
  );
}
