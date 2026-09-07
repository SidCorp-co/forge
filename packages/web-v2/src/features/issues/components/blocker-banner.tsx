"use client";

// cm:guard render only, and every field it renders comes from ONE `deriveBlockerState` verdict — re-joining status, `pipelineHealth` or the `blocks` edges here would give the banner a second opinion about why the issue is stuck, and the caller renders nothing at all for a null verdict
import { Banner, Button } from "@/design";
import type { BlockerState } from "../derive";
import { IssueRefBadge } from "./issue-ref-badge";

interface BlockerBannerProps {
  blocker: BlockerState;
  slug: string;
  pending: boolean;
  onApprove: () => void;
  onResume: () => void;
  onResumeRun: (runId: string) => void;
  onProvideInfo: () => void;
}

export function BlockerBanner({
  blocker,
  slug,
  pending,
  onApprove,
  onResume,
  onResumeRun,
  onProvideInfo,
}: BlockerBannerProps) {
  const { cta, runId } = blocker;

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
  } else if (cta.kind === "resume-run" && runId) {
    action = (
      <Button
        variant="primary"
        size="sm"
        icon="rerun"
        loading={pending}
        onClick={() => onResumeRun(runId)}
      >
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
          // cm:why the body is deliberately NOT rendered here — it is a full agent comment that already renders in the thread below; duplicating it into the banner buried the one thing a banner is for, which is naming the next action. `question` survives as a presence signal only.
          <p className="opacity-90">The agent left a question in the comments below.</p>
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
