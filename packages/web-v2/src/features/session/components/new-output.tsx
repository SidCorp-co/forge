"use client";

import { Icon } from "@/design";

/**
 * The pill, pinned to the bottom of the thread's own viewport.
 */
export function NewOutput({ onGo }: { onGo: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-3 z-10 flex justify-center">
      <button
        type="button"
        data-testid="new-output"
        onClick={onGo}
        className="pointer-events-auto flex min-h-9 items-center gap-1.5 rounded-pill border border-line bg-surface px-3 py-1.5 text-muted shadow-xs hover:bg-hover hover:text-default focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        style={{ fontSize: "var(--text-12)" }}
      >
        <Icon name="chevronDown" size={12} className="flex-none" />
        <span>New output</span>
      </button>
    </div>
  );
}
