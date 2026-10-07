"use client";

import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { TURN_PAGE_CAP, TURN_PAGE_SIZE } from "../hooks";

/** The end of a transcript cut at the page cap: says so, and loads the next batch on request. */
export function TurnsTruncated({
  loaded,
  loading,
  live,
  onLoad,
}: {
  loaded: number;
  loading: boolean;
  /** The session is still producing turns, all of them past the loaded range. */
  live?: boolean;
  onLoad: () => void;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <div
      data-testid="turns-truncated"
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle pt-3"
    >
      <p className="fg-body-sm text-muted">
        {t("sessions.truncated", { n: time.number(loaded) })}
        {live && ` ${t("sessions.truncatedLive")}`}
      </p>
      <button
        type="button"
        disabled={loading}
        onClick={onLoad}
        className="fg-body-sm text-accent-text hover:underline disabled:text-muted disabled:no-underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {loading ? t("sessions.truncatedLoading") : t("sessions.truncatedLoad", { n: time.number(TURN_PAGE_CAP * TURN_PAGE_SIZE) })}
      </button>
    </div>
  );
}
