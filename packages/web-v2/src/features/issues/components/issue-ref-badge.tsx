"use client";

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
