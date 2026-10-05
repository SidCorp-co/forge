import type { ReleaseNotes } from '@forge/contracts/release-notes';
import type { SQL } from 'drizzle-orm';
import type { JobType } from '../db/schema.js';
import { portSlot } from '../lib/port-slot.js';
/** One dependency edge of an issue, as relation expansion reads it. */
export interface IssueRelationEdge {
  otherIssueId: string;
  kind: string;
  expired: boolean;
}

/** The text an issue is indexed under, and the two facts its memory row's metadata carries. */
export interface IssueHead {
  title: string;
  description: string | null;
  descriptionFormat: string | null;
  priority: string;
  category: string | null;
}

/** A live issue as release reconciliation reads it. */
export interface ReleasedIssue {
  issSeq: number;
  issuePrefix: string | null;
  title: string;
  description: string | null;
  plan: string | null;
  releaseNotes: ReleaseNotes | null;
  mergedAt: Date | null;
}

/**
 * The issue facts memory reads but does not own. Issues, comments and jobs sit downstream of
 * memory (Work and Execution after Knowledge), so memory names what it needs and the composition
 * root fills it at boot.
 */
export interface MemoryIssueReads {
  /** `ISS-nn` for each issue id. */
  displayIds(issueIds: string[]): Promise<Map<string, string>>;
  /** Every dependency edge of each issue, both directions, expired ones included. */
  relationEdges(issueIds: string[], projectId: string): Promise<Map<string, IssueRelationEdge[]>>;
  /** The issue's current head, archived or not; null when no such issue. */
  head(issueId: string): Promise<IssueHead | null>;
  /** The issue in this project, unarchived, with its project's prefix; null otherwise. */
  releasedIssue(projectId: string, issueId: string): Promise<ReleasedIssue | null>;
  /** The newest `limit` comment bodies on the issue, newest first. */
  recentCommentBodies(issueId: string, limit: number): Promise<string[]>;
  /** The project's comments on unarchived issues since `since`, newest first, at most `limit`. */
  commentsSince(
    projectId: string,
    since: Date,
    limit: number,
  ): Promise<{ body: string; issueTitle: string }[]>;
  /** The project's status-change payloads on unarchived issues since `since`, newest first. */
  statusChangesSince(
    projectId: string,
    since: Date,
    limit: number,
  ): Promise<{ payload: unknown; issueTitle: string }[]>;
  /** The job's type; null when no such job. */
  jobType(jobId: string): Promise<JobType | null>;
  /** A subquery yielding the project's archived issue ids as text, for `NOT IN`. */
  archivedIssueIds(projectId: string): SQL;
}

const slot = portSlot<MemoryIssueReads>('memory', 'provideMemoryIssueReads');
export const provideMemoryIssueReads = slot.provide;
export const memoryIssueReads = slot.get;
