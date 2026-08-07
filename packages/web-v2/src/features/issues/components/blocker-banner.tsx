"use client";

// ISS-377 Tier-1 "why is it stuck" surface. Renders the single server-derived
// `BlockerState` (from `deriveBlockerState` — the ONE join of status /
// pipelineHealth.waitingOn / blocks edges) as a prominent banner. Shown ONLY
// when blocked; the screen renders nothing when the verdict is null (AC#1/#2).
// The banner says WHY + WHO + the next action.
import { Banner, Button, Markdown } from "@/design";
import type { BlockerState } from "../derive";
import { IssueRefBadge } from "./issue-ref-badge";

interface BlockerBannerProps {
  blocker: BlockerState;
  slug: string;
  pending: boolean;
  onApprove: () => void;
  onResume: () => void;
  onProvideInfo: () => void;
}

export function BlockerBanner({
  blocker,
  slug,
  pending,
  onApprove,
  onResume,
  onProvideInfo,
}: BlockerBannerProps) {
  const { cta } = blocker;

  let action: React.ReactNode = null;
  if (cta.kind === "approve") {
    action = (
      <Button variant="primary" size="sm" icon="check" loading={pending} onClick={onApprove}>
        {cta.label}
      </Button>
    );
  } else if (cta.kind === "resume") {
    action = (
      <Button variant="secondary" size="sm" icon="rerun" loading={pending} onClick={onResume}>
        {cta.label}
      </Button>
    );
  } else if (cta.kind === "provide-info") {
    action = (
      <Button variant="primary" size="sm" icon="mail" onClick={onProvideInfo}>
        {cta.label}
      </Button>
    );
  }

  return (
    <Banner tone={blocker.tone} action={action ?? undefined}>
      <div className="space-y-1">
        <p className="font-medium">{blocker.reason}</p>
        <p className="opacity-90">{blocker.whoMustAct}</p>
        {blocker.question && (
          // cm:why the question is a raw comment body — markdown with fenced diagrams and hard line breaks; a bare <p> collapsed every newline into a space, so a clarify decision-fork arrived as one unreadable paragraph
          <div className="mt-1 rounded-md bg-app/40 px-2 py-1">
            <div className="font-medium">Question</div>
            <Markdown className="mt-1 max-h-80 overflow-auto">{blocker.question}</Markdown>
          </div>
        )}
        {blocker.detail && <p className="opacity-80">{blocker.detail}</p>}
        {blocker.blockingRefs && blocker.blockingRefs.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="opacity-80">Blocked by:</span>
            {blocker.blockingRefs.map((ref) => (
              <IssueRefBadge
                key={ref.id}
                id={ref.id}
                slug={slug}
                displayId={ref.displayId}
                title={ref.title}
                status={ref.status}
              />
            ))}
          </div>
        )}
      </div>
    </Banner>
  );
}
