import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { consume } from '../outbox/index.js';
import { handlePmJobFailedAutoDisable } from './auto-disable.js';
import { spawnPmSession } from './spawner.js';

export function registerPmSubscribers(): void {
  consume('job.transitioned', {
    name: 'pm',
    handle: async (p) => {
      if (p.to !== 'failed') return;
      const [job] = await db
        .select({ type: jobs.type, failureKind: jobs.failureKind })
        .from(jobs)
        .where(eq(jobs.id, p.id))
        .limit(1);
      if (!job) return;
      if (job.type === 'pm') {
        await handlePmJobFailedAutoDisable({ type: job.type, projectId: p.projectId });
        return;
      }
      await spawnPmSession({
        projectId: p.projectId,
        cause: 'job-failed',
        eventRef: {
          jobId: p.id,
          jobType: job.type,
          failureKind: job.failureKind ?? null,
          issueId: p.issueId,
        },
      });
    },
  });

  consume('issue.transitioned', {
    name: 'pm',
    handle: async (p) => {
      if (p.to !== 'needs_info') return;
      await spawnPmSession({
        projectId: p.projectId,
        cause: 'needs-info',
        eventRef: { issueId: p.id, from: p.from },
      });
    },
  });

  consume('dependency.changed', {
    name: 'pm',
    handle: async (p) => {
      await spawnPmSession({
        projectId: p.projectId,
        cause: 'graph-changed',
        eventRef: { edgeId: p.edgeId, from: p.fromIssueId, to: p.toIssueId, kind: p.kind },
      });
    },
  });
}
