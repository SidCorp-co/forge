// roadmap-eta: Now / Next / Later by requirement, each with the p50-p85 range the forecast gives
// for it in people's hands. A requirement the forecast holds no range for says why in `basis`,
// with no date: a figure the forecast does not hold is never invented here (VISION: state-never-lies).

import type { DeliveryForecast } from '@forge/contracts/forecast';
import {
  defineReportQuery,
  type ReportCell,
  type ReportField,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { z } from 'zod';
import { readProjectStatus } from '../project-status/index.js';
import { defineAdapter, type ReportQueryAdapter } from './adapter.js';

const STATUS_DAYS = 7;
const LANES = ['now', 'next', 'later'] as const;

const OUTPUT = [
  { name: 'lane', type: 'status', label: 'Lane' },
  { name: 'key', type: 'ref', label: 'Requirement' },
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'state', type: 'status', label: 'State', vocabulary: 'requirement' },
  { name: 'p50At', type: 'date', label: 'Likely by (p50)' },
  { name: 'p85At', type: 'date', label: 'Almost surely by (p85)' },
  { name: 'basis', type: 'string', label: 'Basis' },
] as const satisfies readonly ReportField[];

const params = z.object({
  /** Keep only this lane. */
  lane: z.enum(LANES).optional(),
});

/** The range in people's hands where the forecast holds one, else the reason it holds none. */
export function etaOf(delivery: DeliveryForecast | null): {
  p50At: string | null;
  p85At: string | null;
  basis: string;
} {
  const none = (basis: string) => ({ p50At: null, p85At: null, basis });
  if (!delivery) return none('no open work');
  if (delivery.shipped?.at) return none('shipped');
  if (delivery.inHands) {
    return { p50At: delivery.inHands.p50At, p85At: delivery.inHands.p85At, basis: 'forecast' };
  }
  const release = delivery.release;
  if (release?.kind === 'person') return none(`waits on ${release.who} to ${release.act}`);
  const landing = delivery.landing;
  switch (landing.kind) {
    case 'paused':
      return none(`waits on ${landing.who} to ${landing.act}`);
    case 'not_enough_history':
      return none('not enough history to forecast');
    case 'landed':
      return none('landed, awaiting release');
    case 'ended':
      return none(`ended: ${landing.status}`);
    case 'forecast':
      return none('landing forecast, release not forecast');
  }
}

export const roadmapEta: ReportQueryAdapter<typeof params> = defineAdapter({
  descriptor: defineReportQuery({
    id: 'roadmap-eta',
    version: 1,
    title: 'Roadmap with delivery ranges',
    params,
    output: OUTPUT,
    permission: 'project.read',
    egress: 'product',
    surfaces: ['rest', 'chat', 'cli'],
  }),
  reads: ['project-status/read.ts:readProjectStatus', 'forecast/scope.ts:readForecastLine'],
  async run(ctx, p): Promise<ReportFrame> {
    const { roadmap } = await readProjectStatus(
      ctx.projectId,
      ctx.viewer,
      STATUS_DAYS,
      ctx.now ?? new Date(),
    );
    const rows: Record<string, ReportCell>[] = [];
    for (const lane of LANES) {
      if (p.lane !== undefined && p.lane !== lane) continue;
      for (const item of roadmap[lane]) {
        rows.push({
          lane,
          key: item.key,
          title: item.title,
          state: item.state,
          ...etaOf(item.delivery),
        });
      }
    }
    return { fields: [...OUTPUT], rows };
  },
});
