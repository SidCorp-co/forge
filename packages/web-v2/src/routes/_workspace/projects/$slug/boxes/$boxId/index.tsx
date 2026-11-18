import { createFileRoute } from "@tanstack/react-router";
import { BoxAlone } from "@/features/boxes";
import { canWriteProject, useProjects } from "@/features/projects";
import { useParams } from "@/lib/navigation/router";

// A box's screen alone (ISS-1325): the address a link from an issue, a release, a posted message or a
// phone opens on. The box is read by its id, so a reader it is not for is refused by core, by name.
function ProjectBoxPage() {
  const { slug, boxId } = useParams<{ slug: string; boxId: string }>();
  const projects = useProjects().data ?? [];
  const canWriteIn = (projectId: string) => projects.some((p) => p.id === projectId && canWriteProject(p.role));
  return <BoxAlone boxId={boxId} slug={slug} canWriteIn={canWriteIn} />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/boxes/$boxId/")({ component: ProjectBoxPage });
