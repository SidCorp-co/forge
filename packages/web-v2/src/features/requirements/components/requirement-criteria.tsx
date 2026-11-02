// A requirement's criteria, read on its overview under the goal (REQ-65 BC-7, ISS-691): short rows
// under their verdict pills, then, while the requirement is not done, the steps of each linked design
// each criterion touches, picked by hand. "k/n verified" is the strip's, above the tabs, so this does
// not say it again; the developer view adds the revision the wording is read at.

import { ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { RequirementDetail } from "../types";
import { CriteriaTrace } from "./criteria-trace";
import { CriteriaChecklist } from "./requirement-proof";

export function RequirementCriteria({ d, projectId, slug, developer }: { d: RequirementDetail; projectId: string; slug: string; developer: boolean }) {
  const t = useCopy();
  return (
    <section data-testid="view-criteria">
      <ViewHeading>{t("requirements.criteria.heading")}</ViewHeading>
      {developer ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-muted" data-testid="criteria-developer">
          {d.standing.shownRevision !== null ? <span>{t("requirements.criteria.wordingOf", { r: d.standing.shownRevision })}</span> : null}
        </div>
      ) : null}
      <CriteriaChecklist d={d} slug={slug} developer={developer} />
      {d.standing.attentionGroup !== "done" ? <CriteriaTrace projectId={projectId} d={d} /> : null}
    </section>
  );
}
