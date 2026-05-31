"use client";

// Project-level layout (ISS-307, Concept B). Renders the horizontal project tab
// bar above every project sub-route (Overview / Issues / Pipeline / Sessions +
// More▾). The project sub-nav used to live in the left rail; the rail is now
// workspace-only. Each tab is a distinct route, so deep-links work and the
// app-router restores scroll position on browser back/forward.
import { useParams } from "next/navigation";
import { ProjectTabBar } from "@/features/projects/components/project-tab-bar";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-none pt-3">
        {slug && <ProjectTabBar slug={slug} />}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
