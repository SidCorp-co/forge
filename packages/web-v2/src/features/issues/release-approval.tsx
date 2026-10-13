
import type { IssueStatus } from "@forge/contracts/issue-machine";
import { type IssueStatusTone, issueStatusToneOn } from "@forge/contracts/issue-vocabulary";
import { createContext, type ReactNode, use } from "react";

const ReleaseApprovalContext = createContext<boolean | undefined>(undefined);

export function ReleaseApprovalProvider({ value, children }: { value: boolean | undefined; children: ReactNode }) {
  return <ReleaseApprovalContext value={value}>{children}</ReleaseApprovalContext>;
}

/** The status's tone on this project, or undefined where the project's release rule is not known here. */
export function useStatusTone(status: string): IssueStatusTone | undefined {
  const approval = use(ReleaseApprovalContext);
  return approval === undefined ? undefined : issueStatusToneOn(status as IssueStatus, approval);
}
