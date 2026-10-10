import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { ProjectSettingsScreen } from "@/features/project-settings/components/project-settings-screen";

function ProjectSettingsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  if (!slug) return null;
  return <ProjectSettingsScreen slug={slug} />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/settings/")({ component: ProjectSettingsPage });
