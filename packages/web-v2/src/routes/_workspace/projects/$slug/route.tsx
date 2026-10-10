import { Outlet, createFileRoute } from "@tanstack/react-router";
import { MovedNotice } from "@/features/shell/components/moved-notice";

function ProjectLayout() {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <MovedNotice />
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug")({ component: ProjectLayout });
