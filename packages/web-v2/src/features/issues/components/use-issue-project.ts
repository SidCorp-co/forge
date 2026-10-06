"use client";

import { usePolicyDocument } from "@/features/project-config/hooks";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";

/** What the issue's project lets this reader do here, and the delivery policy the issue is read against. */
export function useIssueProject(projectId: string) {
  const projectsQ = useProjects();
  const projectRole = projectsQ.data?.find((p) => p.id === projectId)?.role;
  return { projectRole, canWrite: canWriteProject(projectRole), policyQ: usePolicyDocument(projectId) };
}
