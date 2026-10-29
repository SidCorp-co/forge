import { createFileRoute } from "@tanstack/react-router";
import { ChannelsScreen } from "@/features/channels";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectChannelsPage() {
  const t = useCopy();
  return <ProjectRefGate label={t("channels.loading")}>{(p) => <ChannelsScreen projectId={p.ref} slug={p.slug} />}</ProjectRefGate>;
}

export const Route = createFileRoute("/_workspace/projects/$slug/channels/")({ component: ProjectChannelsPage });
