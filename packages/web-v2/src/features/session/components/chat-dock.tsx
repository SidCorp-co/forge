"use client";

// Chrome-style docked chat panel (ISS split-view). Instead of overlaying the
// content as a SlideOver, the chat lives as a resizable right-hand column in the
// workspace flex row — the main content reflows/shrinks beside it, exactly like
// a browser side panel. Desktop-only (md+); below md the layout keeps the
// SlideOver overlay (a fixed split doesn't fit a phone width).
//
// The panel wraps the same ChatScreen used by the overlay, passing `onClose` so
// its header carries the collapse control (one header, no dock chrome on top).
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatScreen } from "./chat-screen";

/** Width bounds for the dock (px). Below MIN the composer/header crowd; above
 *  MAX the content column gets uselessly narrow on common laptop widths. */
const MIN_W = 360;
const MAX_W = 900;

export function ChatDock({
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
  // Track the live width locally during a drag so pointer moves re-render ONLY
  // this panel, not the whole (memo-heavy) workspace layout; the persisted
  // width is committed once on pointer-up. Adopt the prop when it changes and
  // we're not mid-drag (initial localStorage hydrate, cross-nothing).
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
    // The dock is right-anchored, so it widens as the pointer travels left.
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
        /* pointer already released */
      }
      const committed = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
      onWidthChange(committed);
    },
    [onWidthChange],
  );

  return (
    <aside
      className="relative hidden h-full flex-none flex-col border-l border-line bg-app md:flex"
      style={{ width: w }}
      aria-label="Agent chat panel"
    >
      {/* Splitter on the left edge — drag to resize, Chrome-panel style. Sits
          half over the border so the whole seam is a grab target. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to resize"
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[color:var(--link)]"
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatScreen projectId={projectId} onClose={onClose} initialDraft />
      </div>
    </aside>
  );
}
