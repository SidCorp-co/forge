import { createFileRoute } from "@tanstack/react-router";
import { BoxesScreen } from "@/features/boxes";
import { canWriteProject, ProjectGate } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";

// A project's Forge Boxes (ISS-1276): what agents are testing, live, and a box to test by hand.
function ProjectBoxesPage() {
  const t = useCopy();
  return <ProjectGate label={t("boxes.title")}>{(p) => <BoxesScreen projectId={p.id} canWrite={canWriteProject(p.role)} />}</ProjectGate>;
}

export const Route = createFileRoute("/_workspace/projects/$slug/boxes/")({ component: ProjectBoxesPage });
