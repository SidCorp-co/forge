// A requirement's Activity tab: its comments, history, the steward's acts, its revisions and its
// decisions, each folded until opened (REQ-43 BC-8, REQ-48 BC-12).

import { Disclosure } from "@/design";
import { EntityCommentThread } from "@/features/comments";
import { canWriteProject, useProjects } from "@/features/projects";
import { StewardActs } from "@/features/standing";
import { useCopy } from "@/lib/i18n/interface-language";
import type { RequirementDetail } from "../types";
import { RequirementDecisions } from "./requirement-decisions";
import { History, RevisionList } from "./requirement-proof";

/**
 * The Activity view: the requirement's comments, where a person asks, notes or records a decision on
 * it; its history of revisions and sign-offs; every revision; and the decisions taken on it. These are
 * the past items (REQ-43 BC-8), each folded until opened; a thread is read only once its fold opens.
 */
export function RequirementActivity({ projectId, slug, d }: { projectId: string; slug: string; d: RequirementDetail }) {
  const t = useCopy();
  const role = useProjects().data?.find((p) => p.id === projectId)?.role;
  return (
    <section data-testid="view-activity" aria-label={t("requirements.tab.activity")}>
      <Disclosure title={t("requirements.activity.comments")}>
        <EntityCommentThread projectId={projectId} scope="requirement" targetRef={d.key} />
      </Disclosure>
      <div className="-mt-px">
        <Disclosure title={t("requirements.activity.history")} count={d.history.length}>
          <History entries={d.history} />
        </Disclosure>
      </div>
      <div className="-mt-px">
        <StewardActs projectId={projectId} subjectKey={d.key} canWrite={canWriteProject(role)} fold />
      </div>
      <div className="-mt-px" data-testid="revision-fold">
        <Disclosure title={t("requirements.revision.all")} count={d.revisions.length}>
          <RevisionList d={d} />
        </Disclosure>
      </div>
      {/* the decisions fold themselves, by decisions and answers, beside the composer that records one */}
      <div className="mt-6" data-testid="view-decisions">
        <RequirementDecisions key={d.key} projectId={projectId} slug={slug} reqKey={d.key} />
      </div>
    </section>
  );
}
