"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjectRef } from "@/features/projects/project-ref";
import type { ProjectListItem } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";

const PROJECT_NOT_FOUND = {
  title: "Project not found",
  message: "This project doesn't exist or you don't have access to it.",
};

type GateProps<P> = {
  label: string;
  notFound?: { title: string; message: string };
  children: (p: P) => React.ReactNode;
};

type ProjectsRead = ReturnType<typeof useProjectRef>["projectsQ"];

function Waiting({ label, notFound = PROJECT_NOT_FOUND, projectsQ }: { label: string; notFound?: { title: string; message: string }; projectsQ: ProjectsRead }) {
  const { isLoading, isError, error, refetch } = projectsQ;
  return (
    <div className="grid min-h-[60vh] place-items-center">
      {isLoading ? (
        <ProjectLoader label={label} />
      ) : isError ? (
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      ) : (
        <ErrorState title={notFound.title} message={notFound.message} />
      )}
    </div>
  );
}

/** A page under `/projects/<slug>` that renders once the projects list names the project, with its list entry. */
export function ProjectGate({ label, notFound, children }: GateProps<ProjectListItem>) {
  const slug = useParams<{ slug: string }>()?.slug;
  const { ref, row, projectsQ } = useProjectRef(slug);
  if (!projectsQ.isError && row && ref === row.id) return <>{children(row)}</>;
  if (row && !projectsQ.isError) return <div className="grid min-h-[60vh] place-items-center"><ProjectLoader label={label} /></div>;
  return <Waiting label={label} notFound={notFound} projectsQ={projectsQ} />;
}

/**
 * The project a page under `/projects/<slug>` reads for. `ref` is what its reads address the
 * project by: the slug until the projects list answers, the uuid after (`useProjectRef`), so the
 * page's first reads leave with it. `row` is the list's entry once the page has switched to the
 * uuid, absent before; whatever a role or a name decides waits for it.
 */
export interface GatedProject {
  ref: string;
  slug: string;
  row: ProjectListItem | null;
}

/** A page under `/projects/<slug>` that renders at once, reading by the slug until the uuid is known. */
export function ProjectRefGate({ label, notFound, children }: GateProps<GatedProject>) {
  const slug = useParams<{ slug: string }>()?.slug;
  const { ref, row, projectsQ } = useProjectRef(slug);
  if (!projectsQ.isError && ref && slug) {
    return <>{children({ ref, slug, row: row && ref === row.id ? row : null })}</>;
  }
  return <Waiting label={label} notFound={notFound} projectsQ={projectsQ} />;
}
