// The steward's acts in a feedback item's Activity (REQ-48 BC-12), Undo offered to a project writer.

import { canWriteProject, useProjects } from "@/features/projects";
import { StewardActs } from "@/features/standing";

export function FeedbackStewardActs({ projectId, fbKey }: { projectId: string; fbKey: string }) {
  const role = useProjects().data?.find((p) => p.id === projectId)?.role;
  return <StewardActs projectId={projectId} subjectKey={fbKey} canWrite={canWriteProject(role)} />;
}
