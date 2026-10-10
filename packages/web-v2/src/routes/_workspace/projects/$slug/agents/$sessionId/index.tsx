import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { SessionScreen } from "@/features/session";

function ProjectAgentSessionPage() {
  const params = useParams<{ slug: string; sessionId: string }>();
  const slug = params?.slug;
  const sessionId = params?.sessionId;

  if (!slug || !sessionId) return null;

  return <SessionScreen sessionId={sessionId} projectSlug={slug} />;
}

export const Route = createFileRoute("/_workspace/projects/$slug/agents/$sessionId/")({ component: ProjectAgentSessionPage });
