"use client";

// Shared, clickable issue reference (ISS-331). Single source of truth for
// rendering a link to an issue's detail page as a friendly `ISS-X` pill —
// used by relation chips (properties rail) and the sessions list's
// "back to issue" link. Falls back to a plain "Issue" label when the friendly
// `displayId` isn't available at the call site (e.g. session metadata only
// carries the issue UUID).
import Link from "next/link";
import { MonoTag } from "@/design";

export interface IssueRefBadgeProps {
  /** Issue UUID — the routable id (`/projects/:slug/issues/:id`). */
  id: string;
  /** Project slug for the link target. */
  slug: string;
  /** Friendly `ISS-<seq>` identifier. When absent, the badge reads "Issue". */
  displayId?: string | null;
  /** Optional issue title, surfaced as the link tooltip. */
  title?: string | null;
}

export function IssueRefBadge({ id, slug, displayId, title }: IssueRefBadgeProps) {
  return (
    <Link
      href={`/projects/${slug}/issues/${id}`}
      title={title ?? displayId ?? "Open issue"}
      className="inline-flex max-w-full items-center transition-opacity hover:opacity-80 focus-visible:outline-none"
    >
      <MonoTag hue="cobalt">{displayId ?? "Issue"}</MonoTag>
    </Link>
  );
}
