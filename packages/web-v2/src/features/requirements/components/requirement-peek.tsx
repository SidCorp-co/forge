
// The peek (`?peek=REQ-12`) beside the list: the shared PeekPanel holding the full page's header —
// key, state, title, the one primary act — and the page's progress strip, then what the requirement
// says and its criteria, over the same facts its sticky rail shows.

import { FactsGroup, PeekExcerpt, PeekHead, PeekPanel, type FullPage, type PeekState, rememberListOrigin, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { Written } from "@/lib/i18n/written";
import { useRequirement } from "../hooks";
import { REQUIREMENTS_LIST } from "@/lib/routes/requirements";
import { PrimaryActions } from "./requirement-actions";
import { RequirementProperties } from "./requirement-facts";
import { requirementSummary } from "./requirement-overview";
import { PeekCriteria } from "./requirement-proof";
import { RequirementProgress } from "./standing-bits";

export function RequirementPeek({
  projectId,
  slug,
  reqKey,
  peek,
  full,
}: {
  projectId: string;
  slug: string;
  reqKey: string;
  peek: PeekState;
  full: FullPage;
}) {
  const t = useCopy();
  const q = useRequirement(projectId, reqKey);
  return (
    <PeekPanel peek={peek} listLabel={t("requirements.title")} noun={t("requirements.noun")} full={full} testId="requirement-peek">
      <QueryBoundary query={q} loadingLabel={t("requirements.loadingOne")}>
        {(d) => {
          const s = d.standing;
          const summary = requirementSummary(d);
          return (
            <>
              <PeekHead
                noun={t("requirements.noun")}
                itemKey={d.key}
                badge={<StatusBadge family="requirement" value={s.state} />}
                title={d.title}
                action={<PrimaryActions projectId={projectId} slug={slug} d={d} inPeek onReview={() => rememberListOrigin(REQUIREMENTS_LIST)} />}
              />
              <RequirementProgress standing={s} slug={slug} inset="px-4.5" />
              <div className="px-4.5 pt-4">
                {summary ? (
                  <FactsGroup title={t("requirements.overview.summary")} testId="peek-summary">
                    <PeekExcerpt>
                      <Written className="block leading-relaxed text-fg" text={summary.text} lang={summary.lang} />
                    </PeekExcerpt>
                  </FactsGroup>
                ) : null}
                {s.coverage.length > 0 ? (
                  <FactsGroup title={t("requirements.criteria.heading")} count={s.coverage.length} testId="peek-criteria-group">
                    <PeekCriteria d={d} />
                  </FactsGroup>
                ) : null}
              </div>
              <div className="px-4.5 pb-4 pt-4">
                <RequirementProperties d={d} slug={slug} projectId={projectId} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
