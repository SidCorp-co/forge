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
        <MessageSquare className={cn('h-8 w-8 mb-2', isDark ? 'text-outline-variant' : 'text-outline')} />
        <p className={cn('text-xs', isDark ? 'text-outline' : 'text-outline')}>No sessions yet</p>
      </div>
    );
  }

  return (
    <div>
      {sessions.length > 0 && (
        <div className={cn('px-3 py-2 border-b', isDark ? 'border-outline-variant/30' : 'border-outline-variant/30')}>
          <div className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5', isDark ? 'border-outline-variant/30 bg-surface' : 'border-outline-variant/30 bg-surface-container-low')}>
            <Search className={cn('h-3.5 w-3.5 shrink-0', isDark ? 'text-outline' : 'text-outline')} />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); onSearch?.(e.target.value); }}
              placeholder="Search sessions..."
              className={cn('flex-1 bg-transparent text-[16px] sm:text-xs focus:outline-none', isDark ? 'text-on-surface placeholder:text-outline' : 'text-on-surface-variant placeholder-gray-400')}
            />
          </div>
        </div>
      )}
      <div className="divide-y divide-outline-variant/30">
      {filtered.length === 0 && search.trim() && (
        <div className="py-8 text-center">
          <p className={cn('text-xs', isDark ? 'text-outline' : 'text-outline')}>No sessions match "{search}"</p>
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
              <span className={isDark ? 'text-outline' : 'text-outline'}>
                {relativeTime(s.updatedAt || s.createdAt)}
              </span>
              {(s as any).user?.username && (
                <span className={cn('truncate', isDark ? 'text-outline' : 'text-outline')}>
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
