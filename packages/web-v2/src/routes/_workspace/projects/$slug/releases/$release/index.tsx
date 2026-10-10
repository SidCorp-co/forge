import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { ReleaseItemScreen } from "@/features/releases";
import { ProjectGate } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectReleasePage() {
  const t = useCopy();
  const params = useParams<{ slug: string; release: string }>();
  return (
    <ProjectGate label={t("releases.loadingOne")}>
      {(p) => <ReleaseItemScreen projectId={p.id} slug={p.slug} version={decodeURIComponent(params.release)} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/releases/$release/")({ component: ProjectReleasePage });
