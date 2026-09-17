"use client";

// "There is more below" — the one thing a reader who has scrolled up is owed (ISS-1083).
//
// ISS-1078 gave a reader pinned to the bottom a thread that follows the prose as it streams, and
// left a reader who has scrolled up alone: the near-bottom guard in `use-stick-to-bottom.ts` never
// moves them. That is half of the behaviour. The other half is that they are not told, so a person
// who scrolled up to re-read a tool result while an answer was arriving had no way to know the
// answer had finished except to scroll back down and look.
//
// cm:guard this says NEW OUTPUT and never how much of it, and never what it is: the thread below is
// the answer to that, and a count on this pill is a second summary of the turn competing with the
// stage line at its end. It appears only where both halves are true — the reader is away from the
// bottom AND something has arrived since they left.
//
// Kit-only: imports from @/design, semantic tokens, no hex.
import { Icon } from "@/design";

/**
 * The pill, pinned to the bottom of the thread's own viewport.
 */
// cm:why `sticky` inside the scroller rather than absolute over it: the scroll container is the only
// element that knows where its viewport's bottom is, and the surfaces that draw this each have a
// composer, a rail or both sitting under it — positioned against either of those, the pill lands on
// top of the reply box on one surface and behind the rail on the other.
export function NewOutput({ onGo }: { onGo: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-3 z-10 flex justify-center">
      <button
        type="button"
        data-testid="new-output"
        onClick={onGo}
        className="pointer-events-auto flex min-h-9 items-center gap-1.5 rounded-pill border border-line bg-surface px-3 py-1.5 text-muted shadow-xs hover:bg-hover hover:text-default"
        style={{ fontSize: 12 }}
      >
        <Icon name="chevronDown" size={12} className="flex-none" />
        <span>New output</span>
      </button>
    </div>
  );
}
