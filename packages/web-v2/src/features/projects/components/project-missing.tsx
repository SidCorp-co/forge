"use client";

// ISS-1229 r16, judge-41: an archived project's own page said "This project doesn't exist", so a
// person who had archived it could not tell it was there, or how to bring it back. Every page under a
// project's slug answers a slug the live list lacks here: archived, saying when, or not found.
import { EmptyState, ErrorState, ProjectLoader } from "@/design";
import { useUnarchiveProject } from "@/features/project-settings/hooks";
import { useProjectsIncludingArchived, useRetryProjects } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";

const NOT_FOUND = "This project doesn't exist or you don't have access to it.";

const ON_DAY = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** Who may bring a project back: the archive and unarchive routes ask for an org admin. */
function mayUnarchive(p: ProjectListItem): boolean {
  return p.orgRole === "owner" || p.orgRole === "admin";
}

/** What an archived project's page says: archived, when, what is kept, and who can bring it back. */
export function archivedProjectWords(p: ProjectListItem): string {
  const when = p.archivedAt ? ` on ${ON_DAY.format(new Date(p.archivedAt))}` : "";
  const back = mayUnarchive(p)
    ? "Unarchive it to work on it again."
    : "An admin of its organization can unarchive it.";
  return `${p.name} was archived${when}. Its issues, comments, runs and sessions are all kept. ${back}`;
}

function ArchivedWithUnarchive({ project }: { project: ProjectListItem }) {
  const unarchive = useUnarchiveProject(project.id);
  return (
    <EmptyState
      level={1}
      title="This project is archived"
      message={archivedProjectWords(project)}
      action={{
        label: unarchive.isPending ? "Unarchiving…" : "Unarchive project",
        onClick: () => {
          if (!unarchive.isPending) unarchive.mutate();
        },
      }}
    />
  );
}

export function ProjectMissing({
  slug,
  title = "Project not found",
  message = NOT_FOUND,
}: {
  slug: string | undefined;
  title?: string;
  message?: string;
}) {
  const all = useProjectsIncludingArchived();
  const archived = all.data?.find((p) => p.slug === slug && p.archivedAt !== null);
  if (all.isLoading) return <ProjectLoader label="loading project…" />;
  // A list that could not be read cannot say the project is missing from it (ISS-1229 r48).
  if (all.isError && all.data === undefined) return <ProjectsUnread error={all.error} />;
  if (archived && mayUnarchive(archived)) return <ArchivedWithUnarchive project={archived} />;
  if (archived) {
    return <EmptyState level={1} title="This project is archived" message={archivedProjectWords(archived)} />;
  }
  return <EmptyState level={1} title={title} message={message} />;
}

/**
 * The projects list a page resolves its slug against could not be read: the page says that read failed,
 * never that this project did or that it is missing, and its Retry reads every projects query (ISS-1229 r49).
 */
export function ProjectsUnread({ error }: { error: unknown }) {
  const retry = useRetryProjects();
  return <ErrorState level={1} title="Couldn't load your projects" message={formatApiError(error)} onRetry={retry} />;
}
