import { createFileRoute } from "@tanstack/react-router";
import { ChannelScreen } from "@/features/channels";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";
import { useParams } from "@/lib/navigation/router";

function ProjectChannelPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; channel: string }>();
  return (
    <ProjectRefGate label={t("channels.loading")}>
      {(p) => <ChannelScreen projectId={p.ref} rid={decodeURIComponent(params.channel)} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/channels/$channel/")({ component: ProjectChannelPage });
