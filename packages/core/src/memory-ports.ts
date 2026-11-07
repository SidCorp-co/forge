// Memory's and knowledge's reads of what they do not own, composed at the root (ADR 0008): both sit in
// Knowledge, upstream of issues, comments, jobs and requirements, so each is handed what it reads
// here, from the owners' faces. Memory's landing re-check (REQ-89 BC-5, ISS-1121) reads the paths a
// landing changed: the ones the box sent at its commit, else the project's source host at it.

import { commentsSince, recentCommentBodies } from './comments/index.js';
import { embedFeedback } from './feedback/index.js';
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
import { provideKnowledgePorts } from './knowledge/index.js';
import { flagMemoriesForChange, provideMemoryIssueReads, runMemorySearch } from './memory/index.js';
import { readDeclaredSource, webUrlOf } from './project-config/index.js';
import { orgSiblingProjects } from './projects/index.js';
import { releaseVersionsAmong } from './release-batch/index.js';
import { embedRequirementHead, requirementStatusesBySeq } from './requirements/index.js';
import { workflowFlowsOf } from './workflows/index.js';

export function provideKnowledgeAndMemoryPorts(): void {
  provideKnowledgePorts({
    searchMemory: runMemorySearch,
    flagMemoryRecheck: (projectId, change) => flagMemoriesForChange(projectId, change),
    reembedRequirement: embedRequirementHead,
    reembedFeedback: embedFeedback,
  });
  provideMemoryIssueReads({
    displayIds: issueDisplayIds,
    relationEdges: async (issueIds, projectId) => {
      const relations = await loadIssueRelationsForIssues(issueIds, projectId);
      return new Map([...relations].map(([id, r]) => [id, allRelationDigests(r)]));
    },
    head: issueHead,
    releasedIssue: releasedIssueOf,
    landedChange: async (projectId, issueId) => {
      const landed = await landedChangeOf(projectId, issueId);
      if (!landed || landed.paths || !landed.commit) {
        return (
          landed && {
            ...landed,
            ...(landed.paths ? {} : { why: 'the landing names no commit and no paths' }),
          }
        );
      }
      // the box sent no paths at this commit: the project's source host reads what it changed
      try {
        const files = await (await resolveSourceHost(projectId, 'kernel')).commitFiles(
          landed.commit,
        );
        return 'why' in files
          ? { ...landed, why: files.why }
          : { ...landed, paths: [...files.files] };
      } catch (err) {
        return { ...landed, why: err instanceof Error ? err.message : String(err) };
      }
    },
    recentCommentBodies,
    commentsSince,
    statusChangesSince,
    jobType: jobTypeOf,
    archivedIssueIds: archivedIssueIdsSql,
    issuePrefixes: async (projectId) => ({
      active: await activeIssuePrefix(projectId),
      held: await heldIssuePrefixes(projectId),
    }),
    issueStandings: issueStandingsBySeq,
    requirementStatuses: requirementStatusesBySeq,
    workflowFlows: workflowFlowsOf,
    siblingProjects: orgSiblingProjects,
    repositoryWebUrl: async (projectId) => {
      const repository = (await readDeclaredSource(projectId)).repository;
      return repository ? webUrlOf(repository) : null;
    },
    releaseVersions: releaseVersionsAmong,
  });
}
