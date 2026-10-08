// roadmap-eta: Now / Next / Later by requirement, each with the p50-p85 range the forecast gives
// for it — in people's hands, or its landing where a person releases it, as the Requirements list
// shows it. A requirement the forecast holds no range for says "no forecast" and why in `basis`,
// with no date: a figure the forecast does not hold is never invented here (VISION: state-never-lies).

import {
  type DeliveryForecast,
  deliveryDatesOf,
  type ForecastRange,
  type ReleaseLeg,
} from '@forge/contracts/forecast';
import { ROADMAP_HORIZONS } from '@forge/contracts/project-status';
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
const LANES = ROADMAP_HORIZONS;

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

/** What a range was read from, as the list's tooltip says it: who is ahead, what it waits on, the history. */
function landingBasis(f: ForecastRange): string {
  const keys = f.aheadKeys.join(', ');
  const more = f.ahead > f.aheadKeys.length ? ', …' : '';
  return [
    f.ahead > 0 ? `${f.ahead} ahead${keys ? ` (${keys}${more})` : ''}` : 'nothing ahead',
    f.waitsOn.length > 0 ? `waits on ${f.waitsOn.join(', ')} to land first` : null,
    `read from ${f.basis.n} issues landed in the last ${f.basis.windowDays} days`,
  ]
    .filter((p): p is string => p !== null)
    .join('; ');
}

const releaseBasis = (leg: ReleaseLeg | null): string | null => {
  if (leg?.kind === 'automatic') return `release lag read from ${leg.basis.n} releases`;
  if (leg?.kind === 'not_enough_history')
    return `release not forecast: ${leg.n} of ${leg.floor} releases on record`;
  if (leg?.kind === 'person') return `then ${leg.who} to ${leg.act}`;
  return null;
};

/**
 * A requirement's dates and their basis, the dates by `deliveryDatesOf` — the reading the
 * Requirements list's ETA cell takes, so the two never disagree on a figure. Where the forecast
 * holds no date the basis says "no forecast" and why; a date it does not hold is never invented
 * here (VISION: state-never-lies).
 */
export function etaOf(delivery: DeliveryForecast | null): {
  p50At: string | null;
  p85At: string | null;
  basis: string;
} {
  const none = (why: string) => ({ p50At: null, p85At: null, basis: `no forecast: ${why}` });
  if (!delivery) return none('nothing is linked to it yet');
  const { landing, release, shipped } = delivery;
  if (shipped) {
    const at = shipped.at ? ` at ${shipped.at}` : '';
    return {
      p50At: null,
      p85At: null,
      basis: shipped.version ? `shipped in ${shipped.version}${at}` : `shipped${at}`,
    };
  }
  const dates = deliveryDatesOf(delivery);
  const parts = (...p: (string | null)[]) => p.filter((x): x is string => x !== null).join('; ');
  const why = landing.kind === 'forecast' ? landingBasis(landing) : null;
  if (dates?.of === 'hands') {
    return {
      p50At: dates.p50At,
      p85At: dates.p85At,
      basis: parts(
        "in people's hands",
        why ?? (landing.kind === 'landed' ? 'landed' : null),
        releaseBasis(release),
      ),
    };
  }
  if (dates) {
    return {
      p50At: dates.p50At,
      p85At: dates.p85At,
      basis: parts(`lands by then`, releaseBasis(release), why),
    };
  }
  switch (landing.kind) {
    case 'paused':
      return none(`waits on ${landing.who} to ${landing.act}`);
    case 'not_enough_history':
      return none(`not enough history, ${landing.n} of ${landing.floor} landed issues`);
    case 'ended':
      return none(`ended (${landing.status})`);
    case 'landed':
      return release?.kind === 'person'
        ? none(`landed, waits on ${release.who} to ${release.act}`)
        : none(parts('landed, awaiting release', releaseBasis(release)));
    case 'forecast':
      throw new Error(
        'roadmap-eta: a forecast landing held no dates — deliveryDatesOf reads every range',
      );
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
