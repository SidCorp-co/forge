"use client";

// Shared, clickable issue reference (ISS-331). Single source of truth for
// rendering a link to an issue's detail page as a friendly `ISS-X` pill —
// used by relation chips (properties rail) and the sessions list's
// "back to issue" link. Falls back to a plain "Issue" label when the friendly
// `displayId` isn't available at the call site (e.g. session metadata only
// carries the issue UUID).
import Link from "next/link";
import { MonoTag } from "@/design";
import { STATUS_META } from "@/design/status";
import { statusToChip } from "../derive";
import type { IssueStatus } from "../types";

export interface IssueRefBadgeProps {
  /** Issue UUID — the routable id (`/projects/:slug/issues/:id`). */
  id: string;
  /** Project slug for the link target. */
  slug: string;
  /** Friendly `ISS-<seq>` identifier. When absent, the badge reads "Issue". */
  displayId?: string | null;
  /** Optional issue title, surfaced as the link tooltip. */
  title?: string | null;
  /** Optional related-issue status — rendered as a small tone dot before the
   *  pill (reuses the design-kit status tone, no new colors). */
  status?: IssueStatus | null;
  /** When true (and `title` is present), render the title inline after the
   *  pill, truncated to one line — so a relation row is identifiable at a
   *  glance rather than showing only the `ISS-X` number. Off by default to
   *  keep compact callers (blocker banner, sessions link) unchanged. */
  showTitle?: boolean;
}

export function IssueRefBadge({
  id,
  slug,
  displayId,
  title,
  status,
  showTitle = false,
}: IssueRefBadgeProps) {
  const dot = status ? STATUS_META[statusToChip(status)].dot : null;
  const withTitle = showTitle && !!title;
  return (
    <Link
      href={`/projects/${slug}/issues/${id}`}
      title={title ?? displayId ?? "Open issue"}
      className={`${withTitle ? "flex w-full" : "inline-flex"} max-w-full items-center gap-1 transition-opacity hover:opacity-80 focus-visible:outline-none`}
    >
      {dot && (
        <span
          aria-hidden
          className="inline-block size-1.5 flex-none rounded-full"
          style={{ background: dot }}
        />
      )}
      <span className="flex-none">
        <MonoTag hue="cobalt">{displayId ?? "Issue"}</MonoTag>
      </span>
      {withTitle && (
        <span className="fg-caption min-w-0 flex-1 truncate text-left text-xs">{title}</span>
      )}
    </Link>
  );
}
