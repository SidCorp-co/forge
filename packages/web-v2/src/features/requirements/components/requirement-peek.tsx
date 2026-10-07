"use client";

// The peek (`?peek=REQ-12`) beside the list: the shared PeekPanel holding the full page's header —
// key, state, title, the one primary act — over the same facts its sticky rail shows.

import { PeekHead, PeekPanel, type PeekState, rememberListOrigin, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useRequirement } from "../hooks";
import { REQUIREMENTS_LIST } from "@/lib/routes/requirements";
import { PrimaryActions } from "./requirement-actions";
import { RequirementFacts } from "./requirement-facts";
import { RequirementBanner } from "./standing-bits";

export function RequirementPeek({
  projectId,
  slug,
  reqKey,
  peek,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  reqKey: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const q = useRequirement(projectId, reqKey);
  const d = q.data;
  const s = d?.standing;
  const banner = s && (s.waitingOn.kind === "you" || (s.attentionGroup === "stuck" && s.waitingOn.kind === "none"));
  return (
    <PeekPanel peek={peek} listLabel="Requirements" noun="Requirement" onOpenFull={onOpenFull} testId="requirement-peek">
      <QueryBoundary query={q} loadingLabel="loading requirement…">
        {(d) => {
          const s = d.standing;
          return (
            <>
              <PeekHead
                noun="Requirement"
                itemKey={d.key}
                badge={<StatusBadge family="requirement" value={s.state} />}
                title={d.title}
                action={<PrimaryActions projectId={projectId} slug={slug} d={d} inPeek onReview={() => rememberListOrigin(REQUIREMENTS_LIST)} />}
              />
              {banner ? <RequirementBanner standing={s} className="px-[18px]" /> : null}
              <div className="px-[18px] pb-4 pt-4">
                <RequirementFacts d={d} slug={slug} projectId={projectId} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
