"use client";

import { Button } from "@/design";

/** A projects read that failed with no list held: why, and the act that reads it again. */
export interface ProjectsUnread {
  message: string;
  onRetry: () => void;
}

/** Where a project list would stand: the read failed, which is not a list holding no project (ISS-1229 r47). */
export function ProjectsUnreadLine({ unread, className }: { unread: ProjectsUnread; className?: string }) {
  return (
    <div role="alert" data-testid="projects-unread" className={className}>
      <p className="fg-body-sm text-fg">Couldn&apos;t load your projects</p>
      <p className="fg-caption mt-0.5 text-muted">{unread.message}</p>
      <Button variant="secondary" size="sm" className="mt-1.5" onClick={unread.onRetry}>
        Retry
      </Button>
    </div>
  );
}
