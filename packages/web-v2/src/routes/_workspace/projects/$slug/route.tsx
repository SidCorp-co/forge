import { Outlet, createFileRoute } from "@tanstack/react-router";
import { LiveBar } from "@/features/agents";
import { useProjectRef } from "@/features/projects/project-ref";
import { MovedNotice } from "@/features/shell/components/moved-notice";
import { useParams } from "@/lib/navigation/router";

/** What runs on the project now, above every project page once the project's uuid is known (REQ-15 BC-10). */
function ProjectNowBar() {
  const slug = useParams<{ slug: string }>()?.slug;
  const { ref, row } = useProjectRef(slug);
  if (!slug || !row || ref !== row.id) return null;
  return <LiveBar projectId={row.id} slug={row.slug} />;
}

function ProjectLayout() {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <ProjectNowBar />
      <MovedNotice />
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug")({ component: ProjectLayout });
