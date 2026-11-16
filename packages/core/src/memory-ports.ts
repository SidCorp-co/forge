// Memory's reads of what it does not own, composed at the root (ADR 0008): memory sits in Knowledge,
// upstream of issues, comments, jobs and requirements, so it is handed what it reads here, from the
// owners' faces: the issue side in `memory-issue-reads.ts`, the project side below.

import { provideMemoryIssueReads } from './memory/index.js';
import { memoryIssueSide } from './memory-issue-reads.js';
import { readDeclaredSource, webUrlOf } from './project-config/index.js';
import { orgSiblingProjects } from './projects/index.js';
import { releaseVersionsAmong } from './release-batch/index.js';
import { requirementStatusesBySeq } from './requirements/index.js';
import { workflowFlowsOf } from './workflows/index.js';

export function provideMemoryDomainPorts(): void {
  provideMemoryIssueReads({
    ...memoryIssueSide,
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
