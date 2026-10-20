// A `N live sessions` mono figure with an accent pulse dot when any session is live.
// (Kit `LiveDot` reflects WS-connection state, not a count — so this small
// feature component is the right home for the per-project live-session indicator.)
import type { QueryRead } from '@/design/patterns/badge-read';
import { cn } from '@/lib/utils/cn';
import { ReadFigure } from './read-figure';

export interface LiveCountProps {
  n: number | null;
  read: QueryRead;
}

export function LiveCount({ n, read }: LiveCountProps) {
  const live = n !== null && n > 0;
  return (
    <span
      title="Agent sessions live now, as the Pipeline page lists them"
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-12-5',
        live ? 'text-accent-text' : 'text-subtle',
      )}
    >
      {live && (
        <span className="forge-pulse inline-block size-[7px] rounded-pill bg-accent" aria-hidden />
      )}
      <ReadFigure value={n} read={read} counts="live sessions" /> {n === 1 ? "live session" : "live sessions"}
    </span>
  );
}
