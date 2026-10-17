"use client";

import Link from "next/link";
import { Button } from "@/design";
import { sessionKindLabel, sessionName } from "@/features/pipeline/derive";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import type { Holder } from "@/features/pipeline/types";
import { useCancelSession } from "@/features/sessions/hooks";
import { leaseDisagreementText } from "@/features/sessions/status-sentences";

type SessionHolder = Extract<Holder, { by: "session" }>;

/**
 * A session core still holds this issue for, though the session's run reports it returned (ISS-1228
 * round 12). Core refuses another run on the issue while the hold stands, so the page says so in the
 * sentences every surface uses, and stops the session from here. Nothing renders where they agree.
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
  const stop = useCancelSession();
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
          <div key={h.sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="fg-body-sm min-w-0 flex-[1_1_20rem] break-words text-fg">
              Held by {name} on {h.deviceName ?? "an unnamed box"}. {sentence}
            </p>
            <Button
              size="sm"
              variant="danger"
              loading={stop.isPending && stop.variables === h.sessionId}
              onClick={() => stop.mutate(h.sessionId)}
            >
              Stop session
            </Button>
            <Link
              href={`/projects/${slug}/agents/${h.sessionId}`}
              className="fg-caption flex-none text-link underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              Open session
            </Link>
          </div>
        );
      })}
    </div>
  );
}
