import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { approvalsApi } from "./api";
import type { ApprovalAct } from "./types";

/** Every key of the inbox starts here, so a decision anywhere can refresh its count in one call. */
export const approvalKeys = {
  all: ["approvals"] as const,
  inbox: (projectId: string) => [...approvalKeys.all, projectId] as const,
};

export const useApprovals = (projectId: string | undefined) =>
  useQuery(readOf(approvalKeys.inbox(projectId ?? ""), () => approvalsApi.read(projectId as string)));

/**
 * Press an act. A decision here changes what the record's own page, the home's decisions and the
 * menu counts read, so those are read again with the inbox.
 */
export const usePressApproval = () =>
  useWrite(({ act, reason }: { act: ApprovalAct; reason?: string | undefined }) => approvalsApi.press(act, reason), {
    touches: [approvalKeys.all, ["needs-you"], ["suggestions"], ["mockups"], ["requirement"], ["requirements"], ["workflow"], ["workflows"]],
  });
