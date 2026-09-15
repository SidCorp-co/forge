"use client";

// Chrome-style docked conversation panel. Instead of overlaying the content as a
// SlideOver, the conversation lives as a resizable right-hand column in the
// workspace flex row — the main content reflows/shrinks beside it, exactly like
// a browser side panel. Desktop-only (md+); below md the layout keeps the
// SlideOver overlay (a fixed split doesn't fit a phone width).
//
// The panel wraps the same `ConversationPanel` the mobile overlay mounts,
// passing `onClose` so its header carries the collapse control (one header, no
// dock chrome on top). Ported from the chat dock at ISS-1004 step 5: the
// geometry is unchanged. What it wraps changed at ISS-1028, from the chat alone
// to the chat AND its history, because a dock that could only ever show a new
// draft was the whole of the report.
//
// The splitter is an `<hr>` with a tabIndex and the arrow keys bound, never a
// bare `role="separator"` div: it was pointer-only until that port — visible,
// announcing nothing, and unmovable without a mouse.

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationPanel } from "./conversation-panel";

/** Width bounds for the dock (px). Below MIN the composer/header crowd; above
 *  MAX the content column gets uselessly narrow on common laptop widths. */
const MIN_W = 360;
const MAX_W = 900;

export function ConversationDock({
  projectId,
  width,
  onWidthChange,
  onClose,
}: {
  projectId: string;
  /** Persisted panel width (px), owned by the layout. */
  width: number;
  /** Commit a new width (persisted) — called on drag end, not per move. */
  onWidthChange: (w: number) => void;
  onClose: () => void;
}) {
  // cm:guard the live width is LOCAL during a drag and committed once on pointer-up: a pointer move that set the persisted value would re-render the whole memo-heavy workspace layout on every frame, and the prop is adopted only when no drag is in flight so a hydrate cannot fight the hand
  const [w, setW] = useState(width);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) setW(width);
  }, [width]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    // cm:why right-anchored, so the panel widens as the pointer travels LEFT and the arithmetic is the viewport minus the clientX
    const next = window.innerWidth - e.clientX;
    setW(Math.min(MAX_W, Math.max(MIN_W, next)));
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // cm:why a pointer already released throws here and is not a failure: the capture is released by the browser on some cancel paths before this runs
      }
      const committed = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
      onWidthChange(committed);
    },
    [onWidthChange],
  );

  // cm:guard the keyboard step COMMITS on every press rather than on a key-up: there is no pointer-up to commit on, so a width moved by the arrow keys and never persisted would snap back on the next render that adopted the prop.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 64 : 16;
      const delta = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
      if (delta === 0) return;
      e.preventDefault();
      const next = Math.min(MAX_W, Math.max(MIN_W, w + delta));
      setW(next);
      onWidthChange(next);
    },
    [w, onWidthChange],
  );

  return (
    <aside
      className="relative hidden h-full flex-none flex-col border-l border-line bg-app md:flex"
      style={{ width: w }}
      aria-label="Agent conversation panel"
    >

      <hr
        aria-orientation="vertical"
        aria-label="Resize the conversation panel"
        aria-valuenow={w}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to resize"
        className="absolute left-0 top-0 z-10 m-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent transition-colors hover:bg-[color:var(--link)] focus-visible:bg-[color:var(--link)] focus-visible:outline-none"
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationPanel projectId={projectId} onClose={onClose} />
      </div>
    </aside>
  );
}
