
// The issue's criteria with the act that ties the issue to its requirement's criteria, taken on a
// closed issue too: judging shipped work is the point.

import type { IssueDetail } from "../types";
import { TieCriteria } from "./criteria-acts";
import { CriteriaList } from "./criteria-list";

export function IssueCriteria({
  issue,
  projectId,
  checklist,
  canWrite,
  requirementKey,
  developer = false,
}: {
  issue: Pick<IssueDetail, "id" | "status">;
  projectId: string;
  /** The lines of the acceptance-criteria text, read where the issue has no criterion rows yet. */
  checklist: { key: string; text: string; checked: boolean }[];
  canWrite: boolean;
  /** The requirement the issue delivers, by key; null where it delivers none. */
  requirementKey: string | null;
  /** The developer view: trace codes and commits drawn. */
  developer?: boolean;
}) {
  const tie =
    canWrite && requirementKey && issue.status !== "dropped" ? (
      <TieCriteria issueId={issue.id} projectId={projectId} requirementKey={requirementKey} />
    ) : null;
  return <CriteriaList issueId={issue.id} judge={canWrite} headingAct={tie} checklist={checklist} developer={developer} />;
}
