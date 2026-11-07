// What memory reads of issues, comments and jobs, composed at the root (ADR 0008; `memory-ports.ts`
// provides it). A landing's re-check (REQ-89 BC-5, ISS-1121) reads the paths the landing changed:
// the ones the box sent at its commit, else the project's source host at it.

import { commentsSince, recentCommentBodies } from './comments/index.js';
import { resolveSourceHost } from './integrations/source-host/index.js';
import {
  activeIssuePrefix,
  allRelationDigests,
  archivedIssueIdsSql,
  heldIssuePrefixes,
  issueDisplayIds,
  issueHead,
  issueStandingsBySeq,
  landedChangeOf,
  loadIssueRelationsForIssues,
  releasedIssueOf,
  statusChangesSince,
} from './issues/index.js';
import { jobTypeOf } from './jobs/index.js';

/** What a landing changed: the box's paths, else the source host's, else why neither was read. */
async function landedChange(projectId: string, issueId: string) {
  const landed = await landedChangeOf(projectId, issueId);
  if (!landed) return null;
  if (landed.paths) return landed;
  if (!landed.commit) return { ...landed, why: 'the landing names no commit and no paths' };
  try {
    const files = await (await resolveSourceHost(projectId, 'kernel')).commitFiles(landed.commit);
    return 'why' in files ? { ...landed, why: files.why } : { ...landed, paths: [...files.files] };
  } catch (err) {
    return { ...landed, why: err instanceof Error ? err.message : String(err) };
  }
}

export const memoryIssueSide = {
  displayIds: issueDisplayIds,
  relationEdges: async (issueIds: string[], projectId: string) => {
    const relations = await loadIssueRelationsForIssues(issueIds, projectId);
    return new Map([...relations].map(([id, r]) => [id, allRelationDigests(r)]));
  },
  head: issueHead,
  releasedIssue: releasedIssueOf,
  landedChange,
  recentCommentBodies,
  commentsSince,
  statusChangesSince,
  jobType: jobTypeOf,
  archivedIssueIds: archivedIssueIdsSql,
  issuePrefixes: async (projectId: string) => ({
    active: await activeIssuePrefix(projectId),
    held: await heldIssuePrefixes(projectId),
  }),
  issueStandings: issueStandingsBySeq,
};
