"use client";

// A single desktop conversation pane (ISS-689): a bounded, resizable,
// closable card wrapping the existing embedded `SessionScreen` — the same
// per-instance-safe primitive the workspace-tier reply panel already uses
// (local rail-collapse state, no ⌘K recents side-effect). The pane only adds
// the cross-project header (which project this is) + the resize/close chrome;
// loading/error/empty/waiting-for-runner states are all inherited as-is.
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton, StatusChip } from "@/design";
import { SessionScreen } from "@/features/session/components/session-screen";
import { clampPaneWidth, type PaneEntry } from "../hooks/use-conversation-panes";

interface ConversationPaneProps {
  entry: PaneEntry;
  projectName: string;
  projectSlug: string | undefined;
  /** "Waiting for me" signal (ISS-664's `isAwaitingReply`) — mirrors the list. */
  awaiting: boolean;
  onClose: () => void;
  onResize: (width: number) => void;
}

export function ConversationPane({
  entry,
  projectName,
  projectSlug,
  awaiting,
  onClose,
  onResize,
}: ConversationPaneProps) {
  // Track the live width locally during a drag so pointer moves re-render
  // only this pane, not the whole strip; the persisted width commits once on
  // pointer-up (same pattern as `ChatDock`'s resizer).
  const [w, setW] = useState(entry.width);
  const draggingRef = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    if (!draggingRef.current) setW(entry.width);
  }, [entry.width]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = { startX: e.clientX, startWidth: w };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [w],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = draggingRef.current;
    if (!drag) return;
    setW(clampPaneWidth(drag.startWidth + (e.clientX - drag.startX)));
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;
      draggingRef.current = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      onResize(clampPaneWidth(drag.startWidth + (e.clientX - drag.startX)));
    },
    [onResize],
  );

  return (
    <div
      data-pane-session={entry.sessionId}
      className="relative flex h-full min-h-0 flex-shrink-0 flex-col rounded-lg border border-line bg-surface"
      style={{ width: w }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex flex-none items-center gap-2 rounded-t-lg border-b border-line bg-app px-3 py-1.5">
        <span className="fg-caption min-w-0 flex-1 truncate text-muted">{projectName}</span>
        {awaiting && <StatusChip status="waiting" domain="session" size="sm" />}
        <IconButton icon="x" size="sm" aria-label="Close pane" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1">
        <SessionScreen sessionId={entry.sessionId} projectSlug={projectSlug} embedded onClose={onClose} />
      </div>

      {/* Right-edge resizer — drag to widen/narrow this pane only. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to resize"
        className="absolute right-0 top-0 z-10 h-full w-1.5 translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[color:var(--link)]"
      />
    </div>
  );
}
