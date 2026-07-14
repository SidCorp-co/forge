"use client";

// Workspace-tier inline reply panel (ISS-664). Wraps the existing
// `SessionScreen(sessionId, projectSlug)` primitive — the single-session
// render+reply surface already used at `/projects/:slug/agents/:id` — in a
// `SlideOver` so opening a session from the cross-project workspace Sessions
// list doesn't require a full route navigation and doesn't lose sight of the
// rest of the list. `SlideOver` already ships Esc-to-close + a Tab focus trap
// + focus-restore-on-close (ISS-506) and renders full-screen below `sm:` — no
// new a11y/responsive work needed here.
import { EmptyState, SlideOver } from "@/design";
import { SessionScreen } from "@/features/session/components/session-screen";

interface SessionReplyPanelProps {
  /** The session to open, or `null` when the panel is closed. */
  sessionId: string | null;
  /** Resolved project slug for `sessionId`'s project. `undefined` when the
   *  session's project isn't in the caller's resolved (org-scoped) list —
   *  guarded below so an out-of-org session is never rendered (AC6). */
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
        // Belt-and-suspenders (AC6): the workspace list is already org-scoped,
        // so this should be unreachable — but never render a session whose
        // project slug didn't resolve.
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState title="Session unavailable" message="This session's project couldn't be resolved." />
        </div>
      )}
    </SlideOver>
  );
}
