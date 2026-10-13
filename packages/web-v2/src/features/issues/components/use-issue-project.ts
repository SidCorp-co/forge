
import { usePolicyDocument } from "@/features/project-config";
import { useProjects } from "@/features/projects";
import { canWriteProject } from "@/features/projects";

/** What the issue's project lets this reader do here, and the delivery policy the issue is read against. */
export function useIssueProject(projectId: string) {
  const projectsQ = useProjects();
  const projectRole = projectsQ.data?.find((p) => p.id === projectId)?.role;
  return { projectRole, canWrite: canWriteProject(projectRole), policyQ: usePolicyDocument(projectId) };
}
