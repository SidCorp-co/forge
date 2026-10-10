// The POC room entry on a feedback item (REQ-44 BC-1): the project and whether this person may
// write are read here, so the detail page keeps one import for it.

import { OpenRoom } from "@/features/previews";
import { useProjects } from "@/features/projects";
import { canWriteProject } from "@/features/projects";

export function FeedbackRoom({ projectId, about }: { projectId: string; about: string }) {
  const project = useProjects().data?.find((p) => p.id === projectId);
  return <OpenRoom projectId={projectId} slug={project?.slug} about={about} canWrite={canWriteProject(project?.role)} />;
}
