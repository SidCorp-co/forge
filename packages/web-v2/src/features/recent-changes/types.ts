import type { IssueStatus } from "@/features/issues/types";

export interface RecentChangeItem {
  id: string;
  issSeq: number;
  title: string;
  status: IssueStatus;
  updatedAt: string;
  projectSlug: string;
  projectName: string;
}

/** Shape of `GET /api/me/recent-changes` (verbatim from the core route). */
export interface RecentChangesResponse {
  items: RecentChangeItem[];
}
