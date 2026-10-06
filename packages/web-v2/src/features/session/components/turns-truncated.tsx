"use client";

import { TURN_PAGE_CAP, TURN_PAGE_SIZE } from "../hooks";

/** The end of a transcript cut at the page cap: says so, and loads the next batch on request. */
export function TurnsTruncated({
  loaded,
  loading,
  onLoad,
}: {
  loaded: number;
  loading: boolean;
  onLoad: () => void;
}) {
  return (
    <div
      data-testid="turns-truncated"
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle pt-3"
    >
      <p className="fg-body-sm text-muted">
        Showing the first {loaded.toLocaleString()} entries — later entries were not loaded.
      </p>
      <button
        type="button"
        disabled={loading}
        onClick={onLoad}
        className="fg-body-sm text-accent-text hover:underline disabled:text-muted disabled:no-underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {loading ? "Loading…" : `Load the next ${(TURN_PAGE_CAP * TURN_PAGE_SIZE).toLocaleString()}`}
      </button>
    </div>
  );
}
