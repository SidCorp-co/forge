import type { CommitLanding } from './commit-landing.js';
import { shortenCommits } from './merge-record.js';

/** A mark refused by name: `code` is what a caller branches on, the message what a person reads. */
export class MergeMarkerError extends Error {
  constructor(
    readonly code:
      | 'NO_WORK_EVIDENCE'
      | 'ISSUE_NOT_FOUND'
      | 'UNMARK_REQUIRES_NOT_CLOSED'
      | 'NOT_MARKED_MERGED'
      | 'LANDING_REQUIRED'
      | 'LANDING_NOT_THIS_SHAPE'
      | 'MARK_ALREADY_STANDS'
      | 'TARGET_REQUIRED'
      | 'PROJECT_KIND_UNKNOWN'
      | 'LANDING_SHAPE_MOVED'
      | 'LANDING_NOT_DESCENDANT'
      | 'LANDING_COMMIT_REQUIRED'
      | Exclude<CommitLanding, { ok: true }>['code'],
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    // A person reads seven characters of a commit; `details` keeps the whole sha (ISS-1421). A
    // commit the repository lacks is quoted as typed: seven or twelve can equal a real one's (ISS-1300 r5).
    super(code === 'COMMIT_NOT_IN_REPOSITORY' ? message : shortenCommits(message));
    this.name = 'MergeMarkerError';
  }
}
