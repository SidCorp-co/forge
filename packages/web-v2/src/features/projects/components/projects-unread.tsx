"use client";

import { RetryButton } from "@/design";
import { formatApiError } from "@/lib/api/error";

/** A projects read that failed with no list held: why, the failed read itself, and the act that reads it again. */
export interface ProjectsUnread {
  message: string;
  error: unknown;
  onRetry: () => void;
}

export function projectsUnreadOf(error: unknown, onRetry: () => void): ProjectsUnread {
  return { message: formatApiError(error), error, onRetry };
}

/** Where a project list would stand: the read failed, which is not a list holding no project (ISS-1229 r47). */
export function ProjectsUnreadLine({ unread, className }: { unread: ProjectsUnread; className?: string }) {
  return (
    <div role="alert" data-testid="projects-unread" className={className}>
      <p className="fg-body-sm text-fg">Couldn&apos;t load your projects</p>
      <p className="fg-caption mt-0.5 text-muted">{unread.message}</p>
      <RetryButton className="mt-1.5" error={unread.error} onRetry={unread.onRetry} />
    </div>
  );
}
