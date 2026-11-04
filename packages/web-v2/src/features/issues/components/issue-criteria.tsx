
// The issue's criteria. Tying the issue to its requirement's criteria is the agent's act: the page
// offers none (REQ-68 BC-6; judge run d47d6de0 at dev.489 read "Tie to REQ-66 criteria" on ISS-639).

import type { IssueDetail } from "../types";
import { CriteriaList } from "./criteria-list";

export function IssueCriteria({
  issue,
  checklist,
  canWrite,
  developer = false,
}: {
  issue: Pick<IssueDetail, "id" | "status">;
  /** The lines of the acceptance-criteria text, read where the issue has no criterion rows yet. */
  checklist: { key: string; text: string; checked: boolean }[];
  canWrite: boolean;
  /** The developer view: trace codes and commits drawn. */
  developer?: boolean;
}) {
  return <CriteriaList issueId={issue.id} judge={canWrite} checklist={checklist} developer={developer} />;
}
