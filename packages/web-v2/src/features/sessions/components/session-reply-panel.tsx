"use client";

import { EmptyState, SlideOver } from "@/design";
import { SessionScreen } from "@/features/session/components/session-screen";

interface SessionReplyPanelProps {
  /** The session to open, or `null` when the panel is closed. */
  sessionId: string | null;
  slug: string | undefined;
  onClose: () => void;
}

export function SessionReplyPanel({ sessionId, slug, onClose }: SessionReplyPanelProps) {
  const open = !!sessionId;
  return (
    <SlideOver open={open} onClose={onClose} title="Reply" width="clamp(560px, 55vw, 920px)" fitBody>
      {sessionId && slug ? (
        <SessionScreen sessionId={sessionId} projectSlug={slug} embedded onClose={onClose} />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState title="Session unavailable" message="This session's project couldn't be resolved." />
        </div>
      )}
    </SlideOver>
  );
}
