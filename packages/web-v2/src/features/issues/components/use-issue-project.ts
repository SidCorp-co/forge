
import { usePolicyDocument } from "@/features/project-config";
import { useProjects } from "@/features/projects";
import { canManageProject, canWriteProject } from "@/features/projects";
import { useAuth } from "@/providers/auth-provider";

/** What the issue's project lets this reader do here, and the delivery policy the issue is read against. */
export function useIssueProject(projectId: string) {
  const projectsQ = useProjects();
  const projectRole = projectsQ.data?.find((p) => p.id === projectId)?.role;
  return { projectRole, canWrite: canWriteProject(projectRole), policyQ: usePolicyDocument(projectId) };
}

/** Who reads the issue page, as its acts on one row need it: their id, and whether they admin the project. */
export interface IssueViewer {
  userId: string | null;
  canManage: boolean;
}

export function useIssueViewer(projectId: string): IssueViewer {
  const { user } = useAuth();
  const projectsQ = useProjects();
  const role = projectsQ.data?.find((p) => p.id === projectId)?.role;
  return { userId: user?.id ?? null, canManage: canManageProject(role) };
}
