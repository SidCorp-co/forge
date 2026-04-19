'use client';

import { X, ThumbsUp, ThumbsDown, Flag, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/relative-time';
import { useChatLog, useUpdateChatLogRating } from '@/features/chat-log/hooks/use-chat-logs';
import type { QaRating } from '@/features/chat-log/types';

interface ChatLogReplayModalProps {
  logId: string;
  onClose: () => void;
}

export function ChatLogReplayModal({ logId, onClose }: ChatLogReplayModalProps) {
  const { data: log, isLoading } = useChatLog(logId);
  const updateRating = useUpdateChatLogRating();

  function handleRate(rating: QaRating) {
    if (!log) return;
    updateRating.mutate({ id: log.documentId, qaRating: rating });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-primary/50 p-4">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-surface-container-low shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold text-on-surface">Chat Log Replay</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-outline hover:bg-surface-container-high hover:text-on-surface-variant"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-outline" />
          </div>
        ) : !log ? (
          <p className="p-6 text-sm text-outline">Log not found.</p>
        ) : (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Meta strip */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-surface-container-low px-4 py-3 text-xs text-primary-fixed">
              <span><span className="font-medium text-on-surface-variant">Time:</span> {new Date(log.createdAt).toLocaleString()}</span>
              <span><span className="font-medium text-on-surface-variant">Source:</span> {log.source}</span>
              {log.model && <span><span className="font-medium text-on-surface-variant">Model:</span> {log.model}</span>}
              {log.queryIntent && <span><span className="font-medium text-on-surface-variant">Intent:</span> {log.queryIntent}</span>}
              {log.durationMs != null && (
                <span>
                  <span className="font-medium text-on-surface-variant">Duration:</span>{' '}
                  {log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
              {log.iterations > 1 && (
                <span><span className="font-medium text-on-surface-variant">Iterations:</span> {log.iterations}</span>
              )}
            </div>

            {/* Conversation */}
            <div className="space-y-4">
              {/* User message */}
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-surface px-4 py-3">
                  <p className="text-sm text-on-surface whitespace-pre-wrap">{log.query}</p>
                </div>
              </div>

              {/* Assistant reply */}
              {log.reply && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-outline-variant/20 bg-surface-container-low px-4 py-3 shadow-sm">
                    <p className="text-sm text-on-surface whitespace-pre-wrap">{log.reply}</p>
                  </div>
                </div>
              )}

              {log.error && (
                <div className="rounded-lg border border-danger/30 bg-danger-surface px-4 py-3">
                  <p className="text-xs font-medium text-danger">Error</p>
                  <p className="mt-1 text-sm text-danger">{log.error}</p>
                </div>
              )}
            </div>

            {/* Debug info */}
            <div className="space-y-3">
              {/* Token usage */}
              {log.usage && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-outline">Token Usage</p>
                  <div className="flex gap-4 rounded-lg bg-surface-container-low px-4 py-2.5 text-xs text-on-surface-variant">
                    {log.usage.input_tokens != null && (
                      <span>Input: <strong>{log.usage.input_tokens}</strong></span>
                    )}
                    {log.usage.output_tokens != null && (
                      <span>Output: <strong>{log.usage.output_tokens}</strong></span>
                    )}
                  </div>
                </div>
              )}

              {/* RAG Context */}
              {log.ragContext && log.ragContext.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-outline">
                    RAG Context ({log.ragContext.length} hits)
                  </p>
                  <div className="space-y-2">
                    {log.ragContext.map((hit, i) => (
                      <div key={i} className="rounded-lg bg-surface-container-low px-3 py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-on-surface-variant truncate">
                            {hit.title ?? hit.source ?? `Hit ${i + 1}`}
                          </span>
                          {hit.score != null && (
                            <span className="shrink-0 text-outline">score: {Number(hit.score).toFixed(3)}</span>
                          )}
                        </div>
                        {hit.content && (
                          <p className="mt-1 text-primary-fixed line-clamp-2">{hit.content}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tool calls */}
              {log.toolCalls && log.toolCalls.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-outline">
                    Tool Calls ({log.toolCalls.length})
                  </p>
                  <div className="space-y-1.5">
                    {log.toolCalls.map((tc, i) => (
                      <div key={i} className="rounded bg-surface-container-low px-3 py-2 text-xs font-mono text-on-surface-variant">
                        {tc.name ?? tc.tool ?? JSON.stringify(tc).slice(0, 80)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* QA Controls */}
            <div className="border-t pt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-outline">QA Rating</p>
              <div className="flex gap-2">
                {(['good', 'bad', 'flagged'] as QaRating[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => handleRate(r)}
                    disabled={updateRating.isPending}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium capitalize transition-colors',
                      log.qaRating === r
                        ? r === 'good'
                          ? 'border-success bg-success-surface text-success'
                          : r === 'bad'
                          ? 'border-danger bg-danger-surface text-danger'
                          : 'border-warning bg-warning-dim/10 text-warning'
                        : 'border-outline-variant/30 text-primary-fixed hover:bg-surface-container-low'
                    )}
                  >
                    {r === 'good' && <ThumbsUp className="h-4 w-4" />}
                    {r === 'bad' && <ThumbsDown className="h-4 w-4" />}
                    {r === 'flagged' && <Flag className="h-4 w-4" />}
                    {r}
                  </button>
                ))}
              </div>
              {log.qaNotes && (
                <p className="mt-2 text-xs text-primary-fixed italic">{log.qaNotes}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
