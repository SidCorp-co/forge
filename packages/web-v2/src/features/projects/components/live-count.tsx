// A `N live` mono pill with an accent pulse dot when there are active runs.
// (Kit `LiveDot` reflects WS-connection state, not run count — so this small
// feature component is the right home for the per-project live-run indicator.)
import { cn } from '@/lib/utils/cn';

export interface LiveCountProps {
  n: number;
}

export function LiveCount({ n }: LiveCountProps) {
  const live = n > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[12.5px]',
        live ? 'text-accent-text' : 'text-subtle',
      )}
    >
      {live && (
        <span className="forge-pulse inline-block size-[7px] rounded-pill bg-accent" aria-hidden />
      )}
      {n} live
    </span>
  );
}
