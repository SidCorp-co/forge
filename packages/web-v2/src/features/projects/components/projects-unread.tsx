"use client";

import { RetryButton } from "@/design";
import { formatApiError, retryWhen } from "@/lib/api/error";

/** A projects read that failed with no list held: why, the failed read itself, and the act that reads it again. */
export interface ProjectsUnread {
  message: string;
  /** The failed read, which decides whether Retry is offered (ISS-1229 r50). */
  error: unknown;
  /** How long until a second read is accepted, where the answer said (Retry-After); null where it did not. */
  wait: string | null;
  onRetry: () => void;
}

/** A failed projects read as the places showing it read it: why, the read, its wait and its Retry. */
export function projectsUnreadOf(error: unknown, onRetry: () => void): ProjectsUnread {
  return { message: formatApiError(error), error, wait: retryWhen(error), onRetry };
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
