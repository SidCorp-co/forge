// progress-by-requirement: per requirement, the criteria proven of the total, its issues shipped,
// awaiting release and to do, and where it stands on the roadmap: its lane by the one lane rule
// (`ROADMAP_HORIZON_OF`, REQ-33 BC-3) and its forecast with the forecast's basis. Built over the two
// reads the Requirements list reads — its rows and its forecasts — so the report holds every
// requirement the list does, Later and off the roadmap included, with the dates its ETA cell shows
// (ISS-433). This file only lays them out as a frame.

import type { ScopeForecast } from '@forge/contracts/forecast';
import { ROADMAP_HORIZON_OF, ROADMAP_HORIZONS } from '@forge/contracts/project-status';
import {
  defineReportQuery,
  type ReportCell,
  type ReportField,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { REQUIREMENT_STATES, type RequirementSummary } from '@forge/contracts/requirements';
import { z } from 'zod';
import { readRequirementForecasts } from '../forecast/index.js';
import { listRequirementsAs } from '../requirements/index.js';
import { defineAdapter, type ReportQueryAdapter } from './adapter.js';
import { etaOf } from './roadmap-eta.js';

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
    version: 1,
    title: 'Progress by requirement',
    params,
    output: OUTPUT,
    permission: 'project.read',
    egress: 'product',
    surfaces: ['rest', 'chat', 'cli'],
  }),
  reads: ['requirements:listRequirementsAs', 'forecast/scope.ts:readRequirementForecasts'],
  async run(ctx, p): Promise<ReportFrame> {
    const [list, forecasts] = await Promise.all([
      listRequirementsAs(ctx.viewer, ctx.projectId),
      readRequirementForecasts(ctx.projectId, ctx.viewer, ctx.now ?? new Date()),
    ]);
    return { fields: [...OUTPUT], rows: progressRows(list, forecasts.requirements, p.state) };
  },
});

/** Now, Next, Later, then off the roadmap: the order the list's roadmap grouping reads. */
const LANE_ORDER = [...ROADMAP_HORIZONS, null] as const;

/**
 * The frame's rows: each requirement of the list, its figures, its lane (none once it is off the
 * roadmap) and its forecast; a requirement the forecast holds no scope for (a dropped one) says so.
 * Each lane soonest first, then by key.
 */
export function progressRows(
  list: readonly Pick<RequirementSummary, 'key' | 'title' | 'standing' | 'delivery'>[],
  forecasts: readonly Pick<ScopeForecast, 'key' | 'progress' | 'delivery'>[],
  state?: RequirementSummary['standing']['state'],
): Record<string, ReportCell>[] {
  const scopes = new Map(forecasts.map((s) => [s.key, s]));
  const rows = list
    .filter((r) => state === undefined || r.standing.state === state)
    .map((r) => {
      const scope = scopes.get(r.key);
      const lane = ROADMAP_HORIZON_OF[r.standing.state];
      const eta = scope
        ? etaOf(scope.delivery)
        : { p50At: null, p85At: null, basis: `no forecast: ${r.standing.state}` };
      return {
        key: r.key,
        title: r.title,
        state: r.standing.state,
        criteriaProven: r.delivery.criteriaCoverage.passing,
        criteriaTotal: r.delivery.criteriaCoverage.criteria,
        shipped: scope?.progress.shipped ?? 0,
        awaitingRelease: scope?.progress.awaitingRelease ?? 0,
        toDo: scope?.progress.toDo ?? 0,
        lane,
        ...eta,
      };
    });
  const at = (v: ReportCell) => (typeof v === 'string' ? Date.parse(v) : Number.POSITIVE_INFINITY);
  return rows.sort(
    (a, b) =>
      LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) ||
      at(a.p50At) - at(b.p50At) ||
      a.key.localeCompare(b.key, 'en', { numeric: true }),
  );
}
