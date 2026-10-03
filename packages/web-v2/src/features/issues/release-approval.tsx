"use client";

// Whether this project requires a person to approve a release, for the issue chips drawn outside
// core's standing read model (the Table view, the status edit). awaiting_release is a person's turn
// only where it does (contracts `issueStatusToneOn`); with no provider the chip falls back to the
// contract's default tone, and says so by passing no tone at all.

import { type IssueStatusTone, issueStatusToneOn, type KernelIssueStatus } from "@forge/contracts/issue-vocabulary";
import { createContext, type ReactNode, useContext } from "react";

const ReleaseApproval = createContext<boolean | undefined>(undefined);

export function ReleaseApprovalProvider({ value, children }: { value: boolean | undefined; children: ReactNode }) {
  return <ReleaseApproval.Provider value={value}>{children}</ReleaseApproval.Provider>;
}

/** The status's tone on this project, or undefined where the project's release rule is not known here. */
export function useStatusTone(status: string): IssueStatusTone | undefined {
  const approval = useContext(ReleaseApproval);
  return approval === undefined ? undefined : issueStatusToneOn(status as KernelIssueStatus, approval);
}
