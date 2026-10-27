// What the issue page reads beside the row about where its work landed and what a mark of it meets:
// both issue detail routes answer the same four, so they are read in one place.

import { db } from '../db/client.js';
import { collectWorkEvidence } from '../pipeline/work-evidence.js';
import { markCommitCheck } from '../projects/live-source.js';
import { liveReachForIssue } from './live-reach-read.js';
import { observedMergeForIssue } from './merge-record.js';

export async function landingReads(issue: {
  id: string;
  projectId: string;
  issSeq: number;
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}) {
  return {
    liveReach: await liveReachForIssue(issue),
    recordedBranch: (await collectWorkEvidence(issue.id)).branch,
    newestMergedPull: (await observedMergeForIssue(db, issue.id))?.commitSha ?? null,
    markCommitCheck: await markCommitCheck(issue.projectId),
  };
}
