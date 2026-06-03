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
}

export function IssueRefBadge({ id, slug, displayId, title, status }: IssueRefBadgeProps) {
  const dot = status ? STATUS_META[statusToChip(status)].dot : null;
  return (
    <Link
      href={`/projects/${slug}/issues/${id}`}
      title={title ?? displayId ?? "Open issue"}
      className="inline-flex max-w-full items-center gap-1 transition-opacity hover:opacity-80 focus-visible:outline-none"
    >
      {dot && (
        <span
          aria-hidden
          className="inline-block size-1.5 flex-none rounded-full"
          style={{ background: dot }}
        />
      )}
      <MonoTag hue="cobalt">{displayId ?? "Issue"}</MonoTag>
    </Link>
  );
}
