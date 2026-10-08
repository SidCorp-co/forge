// progress-by-requirement: per requirement on the delivery line, the criteria proven of the total,
// its issues shipped, awaiting release and to do, and where it stands on the roadmap: its lane by
// the one lane rule (`ROADMAP_HORIZON_OF`, REQ-33 BC-3) and its forecast with the forecast's basis.
// Built over the project status read, which already decides each of those figures; this file only
// lays them out as a frame.

import { ROADMAP_HORIZON_OF, type StatusRequirement } from '@forge/contracts/project-status';
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
import { etaOf } from './roadmap-eta.js';

const STATUS_DAYS = 7;

const OUTPUT = [
  { name: 'key', type: 'ref', label: 'Requirement' },
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'state', type: 'status', label: 'State', vocabulary: 'requirement' },
  { name: 'criteriaProven', type: 'number', label: 'Criteria proven' },
  { name: 'criteriaTotal', type: 'number', label: 'Criteria' },
  { name: 'shipped', type: 'number', label: 'Issues shipped' },
  { name: 'awaitingRelease', type: 'number', label: 'Issues awaiting release' },
  { name: 'toDo', type: 'number', label: 'Issues to do' },
  { name: 'lane', type: 'status', label: 'Roadmap lane' },
  { name: 'p50At', type: 'date', label: 'Likely by (p50)' },
  { name: 'p85At', type: 'date', label: 'Almost surely by (p85)' },
  { name: 'basis', type: 'string', label: 'Forecast basis' },
] as const satisfies readonly ReportField[];

const params = z.object({
  /** Keep only requirements in this state. */
  state: z.enum(REQUIREMENT_STATES).optional(),
});

export const progressByRequirement: ReportQueryAdapter<typeof params> = defineAdapter({
  descriptor: defineReportQuery({
    id: 'progress-by-requirement',
    version: 2,
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
    const rows = progressRows(status.requirements.items, p.state);
    return { fields: [...OUTPUT], rows };
  },
});

/** The frame's rows: each requirement's figures, its lane (none once it is off the roadmap) and its forecast. */
export function progressRows(
  items: readonly StatusRequirement[],
  state?: StatusRequirement['state'],
): Record<string, ReportCell>[] {
  return items
    .filter((r) => state === undefined || r.state === state)
    .map((r) => ({
      key: r.key,
      title: r.title,
      state: r.state,
      criteriaProven: r.criteria.proven,
      criteriaTotal: r.criteria.total,
      shipped: r.progress.shipped,
      awaitingRelease: r.progress.awaitingRelease,
      toDo: r.progress.toDo,
      lane: ROADMAP_HORIZON_OF[r.state],
      ...etaOf(r.delivery),
    }));
}
