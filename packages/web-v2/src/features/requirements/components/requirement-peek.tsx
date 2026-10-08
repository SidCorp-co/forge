"use client";

// The peek (`?peek=REQ-12`) beside the list: the shared PeekPanel holding the full page's header —
// key, state, title, the one primary act — and the page's progress strip, over the same facts its
// sticky rail shows.

import { PeekHead, PeekPanel, type PeekState, rememberListOrigin, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRequirement } from "../hooks";
import { REQUIREMENTS_LIST } from "@/lib/routes/requirements";
import { PrimaryActions } from "./requirement-actions";
import { RequirementFacts } from "./requirement-facts";
import { RequirementProgress } from "./standing-bits";

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
  const t = useCopy();
  const q = useRequirement(projectId, reqKey);
  return (
    <PeekPanel peek={peek} listLabel={t("requirements.title")} noun={t("requirements.noun")} onOpenFull={onOpenFull} testId="requirement-peek">
      <QueryBoundary query={q} loadingLabel={t("requirements.loadingOne")}>
        {(d) => {
          const s = d.standing;
          return (
            <>
              <PeekHead
                noun={t("requirements.noun")}
                itemKey={d.key}
                badge={<StatusBadge family="requirement" value={s.state} />}
                title={d.title}
                action={<PrimaryActions projectId={projectId} slug={slug} d={d} inPeek onReview={() => rememberListOrigin(REQUIREMENTS_LIST)} />}
              />
              <RequirementProgress standing={s} slug={slug} inset="px-[18px]" />
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
