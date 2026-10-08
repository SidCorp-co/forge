// release-readiness: the release nearest people's hands, then the releases that shipped in the last
// `days`. Built over `readProjectStatus` (its `nextRelease` and `shipped` sections), so the state,
// the progress, whose turn it is and what shipped are the ones the dashboard and the status report
// already say.
//
// Row 0 is always the release in flight, or a `none_in_flight` row saying there is none, and it
// carries the window's totals; the shipped releases follow, newest first. A frame that says nothing
// is in flight therefore still says what shipped, so a narrative read off it cannot claim the
// project has no releases (lane A8d: on dev.185 the frame was empty while 27 releases shipped that
// day, and the narrative said no release was managed).

import {
  PROJECT_STATUS_DAYS_MAX,
  PROJECT_STATUS_ROWS,
  type StatusNextRelease,
  type StatusShipped,
} from '@forge/contracts/project-status';
import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { z } from 'zod';
import { readProjectStatus } from '../project-status/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';

/** How far back the shipped releases reach when the asker names no window. */
export const RELEASE_READINESS_DAYS_DEFAULT = 14;

/** Which part of the frame a row is. Read through no vocabulary: it is drawn sentence-cased. */
export const RELEASE_READINESS_STAGES = ['in_flight', 'none_in_flight', 'shipped'] as const;

const params = z.object({
  /** How many days back the shipped releases reach. */
  days: z
    .number()
    .int()
    .min(1)
    .max(PROJECT_STATUS_DAYS_MAX)
    .default(RELEASE_READINESS_DAYS_DEFAULT),
});

const descriptor = defineReportQuery({
  id: 'release-readiness',
  version: 2,
  title: 'Release readiness',
  params,
  output: [
    { name: 'stage', type: 'status', label: 'Stage' },
    { name: 'release', type: 'ref', label: 'Release' },
    { name: 'state', type: 'status', label: 'State', vocabulary: 'releaseState' },
    { name: 'releasedAt', type: 'date', label: 'Shipped on' },
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
    {
      name: 'shippedReleases',
      type: 'number',
      unit: 'releases',
      label: 'Releases shipped in the window',
    },
    {
      name: 'shippedIssues',
      type: 'number',
      unit: 'issues',
      label: 'Issues shipped in the window',
    },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

type Row = Record<string, ReportCell>;

const BLANK: Row = Object.fromEntries(descriptor.output.map((f) => [f.name, null]));

/** Row 0: the release in flight, or that none is, with the window's shipped totals. */
function inFlightRow(next: StatusNextRelease, shipped: StatusShipped): Row {
  const totals = { shippedReleases: shipped.releaseCount, shippedIssues: shipped.issueCount };
  if (next.version === null || next.state === null) {
    return { ...BLANK, stage: 'none_in_flight', ...totals };
  }
  return {
    ...BLANK,
    stage: 'in_flight',
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
    ...totals,
  };
}

/**
 * The release in flight (or that none is), then the newest releases shipped in the window, at most
 * {@link PROJECT_STATUS_ROWS} of them; row 0 counts every one the window holds.
 */
export function releaseReadinessFrame(
  next: StatusNextRelease,
  shipped: StatusShipped,
): ReportFrame {
  const rows: Row[] = [
    inFlightRow(next, shipped),
    ...shipped.releases.slice(0, PROJECT_STATUS_ROWS).map((r) => ({
      ...BLANK,
      stage: 'shipped',
      release: r.version,
      state: 'shipped',
      releasedAt: r.releasedAt,
      total: r.issueCount,
      shipped: r.issueCount,
      requirements: r.requirements.join(', '),
    })),
  ];
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

export const releaseReadiness = defineAdapter({
  descriptor,
  reads: ['project-status:readProjectStatus'],
  async run({ projectId, viewer, now }, { days }) {
    const status = await readProjectStatus(projectId, viewer, days, now ?? new Date());
    return releaseReadinessFrame(status.nextRelease, status.shipped);
  },
});
