import { useState, useMemo } from 'react';
import { MessageSquare, Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/relative-time';
import { Spinner } from '@/components/ui/spinner';

interface SessionBase {
  documentId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

interface Props<T extends SessionBase = SessionBase> {
  sessions: T[];
  loading: boolean;
  activeSessionId?: string | null;
  onSelect: (session: T) => void;
  onNew: () => void;
  statusDot?: (session: T) => React.ReactNode;
  theme?: 'light' | 'dark';
  /** When provided, each session renders as an <a> tag with this function generating the href */
  getHref?: (session: T) => string;
  /** Extract additional searchable text from a session (e.g. message content) */
  getSearchableText?: (session: T) => string;
  /** Server-side search — when provided, delegates filtering to parent instead of local filtering */
  onSearch?: (query: string) => void;
}

export function SessionList<T extends SessionBase>({ sessions, loading, activeSessionId, onSelect, onNew, statusDot, theme = 'light', getHref, getSearchableText, onSearch }: Props<T>) {
  const isDark = theme === 'dark';
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    // When onSearch is provided, parent handles filtering — use sessions as-is
    if (onSearch) return sessions;
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter((s) => {
      if ((s.title || '').toLowerCase().includes(q)) return true;
      if (getSearchableText) return getSearchableText(s).toLowerCase().includes(q);
      return false;
    });
  }, [sessions, search, onSearch, getSearchableText]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4">
        <MessageSquare className="h-8 w-8 mb-2 text-on-surface-variant" />
        <p className="text-xs text-on-surface-variant">No sessions yet</p>
      </div>
    );
  }

  return (
    <div>
      {sessions.length > 0 && (
        <div className="px-3 py-2 border-b border-outline-variant/30">
          <div className={cn(
            'flex items-center gap-2 rounded-md border border-outline-variant/30 px-2 py-1.5',
            isDark ? 'bg-surface' : 'bg-surface-container-low',
          )}>
            <Search className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); onSearch?.(e.target.value); }}
              placeholder="Search sessions..."
              className="flex-1 bg-transparent text-[16px] sm:text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none"
            />
          </div>
        </div>
      )}
      <div className="divide-y divide-outline-variant/30">
      {filtered.length === 0 && search.trim() && (
        <div className="py-8 text-center">
          <p className="text-xs text-on-surface-variant">No sessions match &quot;{search}&quot;</p>
        </div>
      )}
      {filtered.map((s) => {
        const itemClass = cn(
          'block w-full px-4 py-3 text-left transition-colors',
          isDark
            ? 'hover:bg-surface-container'
            : 'hover:bg-surface-container-low',
          activeSessionId === s.documentId && (isDark ? 'bg-surface-container' : 'bg-surface-container-high')
        );
        const content = (
          <>
            <div className="flex items-center gap-2">
              {statusDot?.(s)}
              <p className={cn('text-sm font-medium truncate flex-1', isDark && 'text-on-surface')}>{s.title || 'Untitled'}</p>
            </div>
            <div className={cn('flex items-center gap-2 text-xs mt-0.5', statusDot && 'ml-4')}>
              {/* Pipeline / issue-bound sessions stamp `metadata.issSeq` at
                  creation time so multiple skill-stages of the same issue
                  glance-link on the sidebar without opening the issue
                  detail. Free-chat sessions have no issSeq → badge skipped. */}
              {typeof (s as any).metadata?.issSeq === 'number' && (
                <span className="text-on-surface-variant font-mono tabular-nums">
                  ISS-{(s as any).metadata.issSeq}
                </span>
              )}
              <span className="text-on-surface-variant">
                {relativeTime(s.updatedAt || s.createdAt)}
              </span>
              {(s as any).user?.username && (
                <span className="truncate text-on-surface-variant">
                  {(s as any).user.username}
                </span>
              )}
            </div>
          </>
        );
        const href = getHref?.(s);
        return href ? (
          <a
            key={s.documentId}
            href={href}
            onClick={(e) => { e.preventDefault(); onSelect(s); }}
            className={itemClass}
          >
            {content}
          </a>
        ) : (
          <button key={s.documentId} onClick={() => onSelect(s)} className={itemClass}>
            {content}
          </button>
        );
      })}
      </div>
    </div>
  );
}
