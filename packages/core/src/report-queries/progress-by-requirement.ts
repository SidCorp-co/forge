// progress-by-requirement: per requirement on the delivery line, the criteria proven of the total
// and its issues shipped, awaiting release and to do. Built over the project status read, which
// already decides each of those figures; this file only lays them out as a frame.

import {
  defineReportQuery,
  type ReportCell,
  type ReportField,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { REQUIREMENT_STATES } from '@forge/contracts/requirements';
import { z } from 'zod';
import { readProjectStatus } from '../project-status/index.js';
import { defineAdapter, type ReportQueryAdapter } from './adapter.js';

const STATUS_DAYS = 7;

const OUTPUT = [
  { name: 'key', type: 'ref', label: 'Requirement' },
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'state', type: 'status', label: 'State' },
  { name: 'criteriaProven', type: 'number', label: 'Criteria proven' },
  { name: 'criteriaTotal', type: 'number', label: 'Criteria' },
  { name: 'shipped', type: 'number', label: 'Issues shipped' },
  { name: 'awaitingRelease', type: 'number', label: 'Issues awaiting release' },
  { name: 'toDo', type: 'number', label: 'Issues to do' },
] as const satisfies readonly ReportField[];

const params = z.object({
  /** Keep only requirements in this state. */
  state: z.enum(REQUIREMENT_STATES).optional(),
});

export const progressByRequirement: ReportQueryAdapter<typeof params> = defineAdapter({
  descriptor: defineReportQuery({
    id: 'progress-by-requirement',
    version: 1,
    title: 'Progress by requirement',
    params,
    output: OUTPUT,
    permission: 'project.read',
    egress: 'product',
    surfaces: ['rest', 'chat', 'cli'],
  }),
  reads: ['project-status/read.ts:readProjectStatus'],
  async run(ctx, p): Promise<ReportFrame> {
    const status = await readProjectStatus(
      ctx.projectId,
      ctx.viewer,
      STATUS_DAYS,
      ctx.now ?? new Date(),
    );
    const rows = status.requirements.items
      .filter((r) => p.state === undefined || r.state === p.state)
      .map(
        (r): Record<string, ReportCell> => ({
          key: r.key,
          title: r.title,
          state: r.state,
          criteriaProven: r.criteria.proven,
          criteriaTotal: r.criteria.total,
          shipped: r.progress.shipped,
          awaitingRelease: r.progress.awaitingRelease,
          toDo: r.progress.toDo,
        }),
      );
    return { fields: [...OUTPUT], rows };
  },
});
