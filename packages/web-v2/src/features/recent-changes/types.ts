// web-v2 feature module: recent-changes. Types mirror the EXISTING core
// endpoint `GET /api/me/recent-changes`
// (`packages/core/src/me/recent-changes-routes.ts`) — do NOT guess field
// names.
import type { IssueStatus } from "@/features/issues/types";

/** One recently-updated issue across every project the caller can see. */
export interface RecentChangeItem {
  id: string;
  issSeq: number;
  title: string;
  status: IssueStatus;
  /** ISO timestamp of the issue's last update. */
  updatedAt: string;
  projectSlug: string;
  projectName: string;
}

/** Shape of `GET /api/me/recent-changes` (verbatim from the core route). */
export interface RecentChangesResponse {
  items: RecentChangeItem[];
}
