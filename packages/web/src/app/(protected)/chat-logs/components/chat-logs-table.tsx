'use client';

import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/relative-time';
import type { ChatLog, QaRating, RagHit } from '@/features/chat-log/types';

const INTENT_COLORS: Record<string, string> = {
  SEARCH: 'bg-info-surface/20 text-info',
  LOOKUP: 'bg-info-surface/20 text-info',
  CREATE: 'bg-success-surface text-success',
  SUMMARY: 'bg-info-surface/20 text-info',
  ACTION: 'bg-surface-variant text-tertiary',
  CHAT: 'bg-surface-container-high text-on-surface-variant',
};

const RATING_COLORS: Record<QaRating, string> = {
  good: 'bg-success-surface text-success',
  bad: 'bg-danger-surface text-danger',
  flagged: 'bg-warning-dim/10 text-warning',
};

function RatingBadge({ rating }: { rating: QaRating | null }) {
  if (!rating) return <span className="text-xs text-outline">-</span>;
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium capitalize', RATING_COLORS[rating])}>
      {rating}
    </span>
  );
}

function IntentBadge({ intent }: { intent: string | null }) {
  if (!intent) return <span className="text-xs text-outline">-</span>;
  const color = INTENT_COLORS[intent] ?? 'bg-surface-container-high text-on-surface-variant';
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium capitalize', color)}>
      {intent}
    </span>
  );
}

function RagHits({ ragContext }: { ragContext: RagHit[] | null }) {
  if (!ragContext || ragContext.length === 0) return <span className="text-xs text-outline">0</span>;
  return <span className="text-xs text-on-surface-variant">{ragContext.length}</span>;
}

interface ChatLogsTableProps {
  logs: ChatLog[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ChatLogsTable({ logs, selectedId, onSelect }: ChatLogsTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-surface-container-low">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-surface-container-low text-left text-xs font-medium uppercase tracking-wider text-primary-fixed">
            <th className="px-4 py-3 w-32">Time</th>
            <th className="px-4 py-3">Query</th>
            <th className="hidden px-3 py-3 w-28 md:table-cell">Intent</th>
            <th className="hidden px-3 py-3 w-20 lg:table-cell">Source</th>
            <th className="hidden px-3 py-3 w-24 lg:table-cell">Duration</th>
            <th className="hidden px-3 py-3 w-20 sm:table-cell">Rating</th>
            <th className="hidden px-3 py-3 w-20 xl:table-cell">RAG Hits</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {logs.map((log) => (
            <tr
              key={log.documentId}
              className={cn(
                'cursor-pointer hover:bg-surface-container-low transition-colors',
                selectedId === log.documentId && 'bg-info-surface/20/60'
              )}
              onClick={() => onSelect(log.documentId)}
            >
              <td className="px-4 py-3 text-xs text-outline whitespace-nowrap">
                {relativeTime(log.createdAt)}
              </td>
              <td className="px-4 py-3">
                <p className="font-medium text-on-surface line-clamp-1 text-sm">
                  {log.query}
                </p>
                {log.reply && (
                  <p className="mt-0.5 text-xs text-outline line-clamp-1">
                    {log.reply}
                  </p>
                )}
              </td>
              <td className="hidden px-3 py-3 md:table-cell">
                <IntentBadge intent={log.queryIntent} />
              </td>
              <td className="hidden px-3 py-3 lg:table-cell">
                <span className="text-xs text-primary-fixed">{log.source}</span>
              </td>
              <td className="hidden px-3 py-3 lg:table-cell">
                {log.durationMs != null ? (
                  <span className="text-xs text-primary-fixed">
                    {log.durationMs < 1000
                      ? `${log.durationMs}ms`
                      : `${(log.durationMs / 1000).toFixed(1)}s`}
                  </span>
                ) : (
                  <span className="text-xs text-outline">-</span>
                )}
              </td>
              <td className="hidden px-3 py-3 sm:table-cell">
                <RatingBadge rating={log.qaRating} />
              </td>
              <td className="hidden px-3 py-3 xl:table-cell">
                <RagHits ragContext={log.ragContext} />
              </td>
            </tr>
          ))}
          {logs.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-sm text-outline">
                No chat logs found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
