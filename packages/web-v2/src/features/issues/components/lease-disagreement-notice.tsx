"use client";

import Link from "next/link";
import { sessionKindLabel, sessionName } from "@/features/pipeline/derive";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import type { Holder } from "@/features/pipeline/types";
import { leaseDisagreementText } from "@/features/sessions/lease-words";

type SessionHolder = Extract<Holder, { by: "session" }>;

/**
 * A session core still holds this issue for, though the session's run reports it returned (ISS-1228
 * round 12). Core refuses another run on the issue while the hold stands, so the page says so in the
 * runs tab's words, with the session to stop. Nothing renders where the box and core agree.
 */
export function LeaseDisagreementNotice({
  projectId,
  issueId,
  slug,
}: {
  projectId: string;
  issueId: string;
  slug: string;
}) {
  const reading = useSessionsAndHolds(projectId).data;
  const hold = reading?.holds.find((h) => h.issueId === issueId);
  const holders = (hold?.holders ?? []).filter(
    (h): h is SessionHolder => h.by === "session" && h.boxReturned === true,
  );
  if (!hold || holders.length === 0) return null;
  const sentence = leaseDisagreementText([hold.displayId]);
  return (
    <div role="status" className="flex flex-col gap-1.5 border-y border-line py-3">
      {holders.map((h) => {
        const live = reading?.sessions.find((s) => s.id === h.sessionId);
        const name = live ? sessionName(live) : h.sessionTitle?.trim() || sessionKindLabel(h.sessionKind);
        return (
          <p key={h.sessionId} className="fg-body-sm flex flex-wrap items-baseline gap-x-2 gap-y-1 text-fg">
            <span className="min-w-0 break-words">
              Held by {name} on {h.deviceName ?? "an unnamed box"} · {sentence}.
            </span>
            <Link
              href={`/projects/${slug}/agents/${h.sessionId}`}
              className="fg-caption flex-none text-link underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              Open session
            </Link>
          </p>
        );
      })}
    </div>
  );
}
