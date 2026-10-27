"use client";

import { type KeyboardEvent, type ReactNode, useEffect } from "react";
import { cn } from "@/lib/utils/cn";
import { useVirtualRows } from "../hooks/use-virtual-rows";
import { RetryLink } from "../primitives/retry-link";

export interface VirtualListMore {
  /** Asks for the next rows. Called once as the end of what is loaded comes into view. */
  onLoad: () => void;
  loading: boolean;
  /** The last ask failed: nothing asks again until the person presses Retry. */
  failed: boolean;
  /** Why it failed, in the product's words, said beside Retry. */
  why?: string | undefined;
  /** The failed ask itself, which decides whether Retry is offered (ISS-1229 r50). */
  error?: unknown;
}

export interface VirtualListProps<Row> {
  /** The rows loaded so far, in order. */
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  renderRow: (row: Row, index: number) => ReactNode;
  /** What a screen reader reads a row as, where its text is not its name. */
  getRowLabel?: (row: Row) => string;
  /** How many rows the list holds in all, loaded or not. A screen reader is told this size. */
  totalCount?: number;
  /** The height a row is taken to have until it is measured. */
  estimateRowHeight?: number;
  /** Present while rows remain to load. Leave it out when everything is loaded. */
  more?: VirtualListMore;
  /** Shown in place of the list when there are no rows. */
  empty?: ReactNode;
  className?: string;
  "aria-label": string;
}

const TYPING = "input, textarea, select, [contenteditable]";
const FIRST_SCREEN_PX = 640;
/** The focus ring lies along the row's own edge, where neither the frame nor the next row can cover
 *  it, and the row keeps its content inset wider than the ring, so the ring covers none of its text. */
const ROW_CLASS =
  "absolute left-0 top-0 w-full p-[3px] border-b border-line-subtle focus-visible:shadow-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-[var(--focus-ring)]";
const FRAME_CLASS = "max-h-[min(70vh,40rem)] overflow-y-auto";

/**
 * A list of rows that puts only the ones in view in the document: the feed pattern, so each row says
 * "3 of 1,300" whether or not its neighbours exist, the arrow keys and PageDown and PageUp walk from
 * row to row, and the row holding focus is never recycled out from under it. It scrolls inside a frame of its own, which
 * a long list needs in order to know what is in view. Rows load as the end of what is held comes
 * into view.
 */
export function VirtualList<Row>({
  rows,
  getRowId,
  renderRow,
  getRowLabel,
  totalCount,
  estimateRowHeight = 64,
  more,
  empty,
  className,
  "aria-label": ariaLabel,
}: VirtualListProps<Row>) {
  const virtual = useVirtualRows({
    count: rows.length,
    estimateSize: estimateRowHeight,
    getKey: (index) => (rows[index] === undefined ? index : getRowId(rows[index] as Row)),
    initialHeight: FIRST_SCREEN_PX,
  });

  const loadable = more !== undefined && !more.loading && !more.failed;
  const onLoad = more?.onLoad;
  useEffect(() => {
    if (loadable && onLoad && rows.length > 0 && virtual.reached >= rows.length - 1) onLoad();
  }, [loadable, onLoad, virtual.reached, rows.length]);

  if (rows.length === 0) return <>{empty ?? null}</>;

  const size = Math.max(totalCount ?? 0, rows.length);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row || (row !== target && target.matches(TYPING))) return;
    const at = Number(row.dataset.index);
    const last = rows.length - 1;
    const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    const next =
      event.key === "PageDown" || (event.key === "ArrowDown" && plain) ? Math.min(at + 1, last)
      : event.key === "PageUp" || (event.key === "ArrowUp" && plain) ? Math.max(at - 1, 0)
      : event.key === "End" && !event.shiftKey && !event.altKey && !event.metaKey ? last
      : event.key === "Home" && !event.shiftKey && !event.altKey && !event.metaKey ? 0
      : null;
    if (next === null) return;
    event.preventDefault();
    virtual.focusRow(next);
  }

  return (
    <div
      ref={virtual.scrollerRef}
      {...virtual.scrollerEvents}
      className={cn(FRAME_CLASS, className)}
    >
      {/* The feed's rows are all the keyboard has: each is a tab stop, and the arrow keys and PageDown/PageUp walk them. */}
      <div
        role="feed"
        aria-label={ariaLabel}
        aria-busy={more?.loading ? true : undefined}
        onKeyDown={onKeyDown}
        className="relative"
        style={{ height: virtual.totalSize }}
      >
        {virtual.rows.map((item) => {
          const row = rows[item.index] as Row;
          return (
            <article
              key={item.key}
              ref={virtual.measureRow}
              data-index={item.index}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the feed pattern makes each article a tab stop, since a row that is not in the document cannot be reached by any other key.
              tabIndex={0}
              aria-posinset={item.index + 1}
              aria-setsize={size}
              aria-label={getRowLabel?.(row)}
              className={ROW_CLASS}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(row, item.index)}
            </article>
          );
        })}
      </div>
      {more && (more.loading || more.failed) ? (
        <div role="status" className="fg-caption flex items-center justify-center gap-2 px-4 py-3 text-muted">
          {more.failed ? (
            <>
              <span>{more.why ? `Couldn't load more. ${more.why}` : "Couldn't load more."}</span>
              <RetryLink error={more.error} onRetry={more.onLoad} />
            </>
          ) : (
            <span>Loading more…</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
