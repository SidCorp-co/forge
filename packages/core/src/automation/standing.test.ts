import { saidDisagreements } from '@forge/contracts/said';
import { needsViewer } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { type ScheduleFacts, scheduleStandingOf as scheduleStandingOf_ } from './standing.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const scheduleStandingOf = ((...a: Parameters<typeof scheduleStandingOf_>) =>
  checked(scheduleStandingOf_(...a))) as typeof scheduleStandingOf_;

const NOW = new Date('2026-10-06T01:00:00.000Z');

const schedule = (over: Partial<ScheduleFacts> = {}): ScheduleFacts => ({
  id: 's1',
  projectId: 'p1',
  name: 'Nightly steward',
  kind: 'prompt',
  cron: '0 2 * * *',
  enabled: true,
  targetProjectSlug: null,
  nextRunAt: null,
  createdAt: NOW,
  owner: null,
  ...over,
});

const reader = (admins: string[], isAdmin = false) => ({
  userId: 'u9',
  canWrite: isAdmin,
  isAdmin,
  holders: { admins, writers: [] },
});

const standingOf = (viewer: ReturnType<typeof reader>) =>
  scheduleStandingOf(schedule(), null, null, { viewer, failStreak: 3, now: NOW });

// H3: a group's wait read "A project admin" whoever held admin, and when nobody did
describe('a schedule whose owner is gone', () => {
  it('names the admins who take it over', () => {
    const s = standingOf(reader(['Ada', 'Bo']));
    expect(s.state).toBe('owner_gone');
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({ kind: 'admins', who: 'Ada, Bo' });
  });

  it('is in an admin viewer’s Needs you', () => {
    expect(needsViewer(standingOf(reader(['Ada'], true)))).toBe(true);
  });

  it('says nobody holds admin, and where it is granted, when nobody does', () => {
    const w = standingOf(reader([])).waitingOn;
    expect(w).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(w.rule).toContain('nobody holds project.admin; grant it under Settings → Members');
  });
});
