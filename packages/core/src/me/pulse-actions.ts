/**
 * The workspace pulse's action queue: one row per condition that holds records, oldest record
 * first, then the larger count, then `PULSE_ACTION_KEYS` order, so one response renders in one order.
 */

import {
  PULSE_ACTION_KEYS,
  PULSE_ACTION_LABELS,
  type PulseActionKey,
  type PulseActionRecord,
  type PulseActionRow,
} from '@forge/contracts/needs-you';
import type {
  PulseIssueIdentity,
  PulseLiveness,
  PulseNotOnLiveIdentity,
  PulseProjectIdentity,
  PulseWork,
} from './pulse-types.js';

const issueRecord = (i: PulseIssueIdentity): PulseActionRecord => ({
  key: i.documentId,
  label: i.issueRef,
  detail: i.title,
  href: `/projects/${i.projectSlug}/issues/${i.documentId}`,
  ageSeconds: i.ageSeconds,
});

const notOnLiveRecord = (i: PulseNotOnLiveIdentity): PulseActionRecord => {
  const first = i.evidence[0];
  return {
    ...issueRecord(i),
    detail: first ? `${i.title} · ${first.sha.slice(0, 8)} not on ${i.deploysFrom}` : i.title,
  };
};

const projectRecord = (p: PulseProjectIdentity, now: Date): PulseActionRecord => ({
  key: p.id,
  label: p.name,
  detail: `${p.backlog} ${p.backlog === 1 ? 'issue' : 'issues'} waiting`,
  href: `/projects/${p.slug}`,
  ageSeconds: p.lastIssueRunAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(p.lastIssueRunAt).getTime()) / 1000))
    : Number.MAX_SAFE_INTEGER,
});

export function pulseActionsOf(
  liveness: PulseLiveness,
  work: PulseWork,
  now: Date,
): PulseActionRow[] {
  const sources: Record<PulseActionKey, { count: number; records: PulseActionRecord[] }> = {
    stuckRuns: {
      count: liveness.stuckRuns.total,
      records: liveness.stuckRuns.shown.map((r) => ({
        key: r.runId,
        label: r.issueRef ?? 'Run',
        detail: r.projectSlug,
        href: r.issueDocId
          ? `/projects/${r.projectSlug}/issues/${r.issueDocId}`
          : `/ops?run=${r.runId}`,
        ageSeconds: r.ageSeconds,
      })),
    },
    abandonedIssues: {
      count: work.abandoned.total,
      records: work.abandoned.shown.map(issueRecord),
    },
    releaseWaiting: {
      count: work.releaseWaiting.total,
      records: work.releaseWaiting.shown.map(issueRecord),
    },
    notOnLive: { count: work.notOnLive.total, records: work.notOnLive.shown.map(notOnLiveRecord) },
    liveUnmeasured: {
      count: work.liveUnmeasured.total,
      records: work.liveUnmeasured.shown.map((p) => ({
        key: p.id,
        label: p.name,
        detail: p.reason,
        href: `/projects/${p.slug}`,
        ageSeconds: null,
      })),
    },
    neverRanProjects: {
      count: work.neverRanProjects.total,
      records: work.neverRanProjects.shown.map((p) => projectRecord(p, now)),
    },
    silentProjects: {
      count: work.silentProjects.total,
      records: work.silentProjects.shown.map((p) => projectRecord(p, now)),
    },
  };
  const rows: PulseActionRow[] = PULSE_ACTION_KEYS.filter((key) => sources[key].count > 0).map(
    (key) => ({
      key,
      ...PULSE_ACTION_LABELS[key],
      count: sources[key].count,
      records: sources[key].records,
      oldestSeconds: sources[key].records.reduce<number | null>(
        (max, r) => (r.ageSeconds === null ? max : Math.max(max ?? 0, r.ageSeconds)),
        null,
      ),
    }),
  );
  return rows.sort((a, b) => {
    const ageA = a.oldestSeconds ?? -1;
    const ageB = b.oldestSeconds ?? -1;
    if (ageA !== ageB) return ageB - ageA;
    if (a.count !== b.count) return b.count - a.count;
    return PULSE_ACTION_KEYS.indexOf(a.key) - PULSE_ACTION_KEYS.indexOf(b.key);
  });
}
