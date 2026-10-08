// release-readiness: the release nearest people's hands, as one row. Built over `readProjectStatus`
// (its `nextRelease` section), so the state, the progress and whose turn it is are the ones the
// dashboard and the status report already say.

import type { StatusNextRelease } from '@forge/contracts/project-status';
import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { z } from 'zod';
import { readProjectStatus } from '../project-status/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';

const descriptor = defineReportQuery({
  id: 'release-readiness',
  version: 1,
  title: 'Release readiness',
  params: z.object({}),
  output: [
    { name: 'release', type: 'ref', label: 'Release' },
    { name: 'state', type: 'status', label: 'State', vocabulary: 'releaseState' },
    { name: 'total', type: 'number', unit: 'issues', label: 'Issues' },
    { name: 'shipped', type: 'number', unit: 'issues', label: 'Shipped' },
    { name: 'awaitingRelease', type: 'number', unit: 'issues', label: 'Awaiting release' },
    { name: 'toDo', type: 'number', unit: 'issues', label: 'To do' },
    { name: 'requirements', type: 'string', label: 'Requirements' },
    { name: 'turnWho', type: 'string', label: 'Waiting on' },
    { name: 'turnAct', type: 'string', label: 'To do' },
    { name: 'behindRelease', type: 'ref', label: 'Draft behind it' },
    {
      name: 'behindIssues',
      type: 'number',
      unit: 'issues',
      label: 'Issues in the draft behind it',
    },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

/** Where no release is cut or collecting, the frame holds no row: nothing stands to be released. */
export function releaseReadinessFrame(next: StatusNextRelease): ReportFrame {
  const rows: Record<string, ReportCell>[] =
    next.version === null || next.state === null
      ? []
      : [
          {
            release: next.version,
            state: next.state,
            total: next.progress.total,
            shipped: next.progress.shipped,
            awaitingRelease: next.progress.awaitingRelease,
            toDo: next.progress.toDo,
            requirements: next.requirements.join(', '),
            turnWho: next.turn?.who ?? null,
            turnAct: next.turn?.act ?? null,
            behindRelease: next.behind?.version ?? null,
            behindIssues: next.behind?.issueCount ?? null,
          },
        ];
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

export const releaseReadiness = defineAdapter({
  descriptor,
  reads: ['project-status:readProjectStatus'],
  async run({ projectId, viewer }) {
    const status = await readProjectStatus(projectId, viewer, 1);
    return releaseReadinessFrame(status.nextRelease);
  },
});
