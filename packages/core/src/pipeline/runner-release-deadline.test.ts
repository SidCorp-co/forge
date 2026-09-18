/**
 * Forge's own clock over a release nothing else settled.
 *
 * The shapes this pass exists for are the ones no delivery will ever arrive
 * for: a process that died between asking GitHub for the tag and hearing the
 * answer, a build GitHub never reported, and a preflight that stopped between
 * two reads. Each is asserted separately, because each leaves a different thing
 * true on the repository and the sentence has to say which.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
const logged: Array<Record<string, unknown>> = [];
vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: (ctx: Record<string, unknown>) => logged.push(ctx),
    error: (ctx: Record<string, unknown>) => logged.push(ctx),
  },
}));

type Row = Record<string, unknown> & { id: string };
let overdue: Row[];
const settled = new Map<string, Record<string, unknown>>();
const settleFailed = vi.fn(async (id: string, patch: Record<string, unknown>) => {
  if (settled.has(id)) return false;
  if (id === 'explodes') throw new Error('write refused');
  settled.set(id, patch);
  return true;
});
vi.mock('../integrations/github/runner-release-store.js', () => ({
  overdueReleases: async () => overdue,
  settleFailed: (...a: unknown[]) => settleFailed(...(a as [string, Record<string, unknown>])),
}));

const { nameOverdueRunnerReleases, RUNNER_RELEASE_DEADLINE_MS } = await import(
  './runner-release-deadline.js'
);

const NOW = new Date('2026-09-18T12:00:00.000Z');
const release = (over: Partial<Row> = {}): Row => ({
  id: 'rel-1',
  tag: 'runner-v0.13.3',
  commitSha: 'abc1234',
  step: 'await_build',
  tagState: 'present',
  publication: 'unread',
  publicationDetail: null,
  startedAt: new Date(NOW.getTime() - 95 * 60_000),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  settled.clear();
  logged.length = 0;
  overdue = [];
});

describe('a build that never reported', () => {
  it('fails the release at the step it was waiting on, naming the tag and the wait', async () => {
    overdue = [release()];
    expect(await nameOverdueRunnerReleases(NOW)).toEqual({ named: 1 });
    const patch = settled.get('rel-1');
    expect(patch?.step).toBe('await_build');
    expect(String(patch?.failure)).toContain('Forge cut `runner-v0.13.3` 95 minutes ago');
    expect(String(patch?.failure)).toContain('reported no build for it');
  });

  // cm:guard criterion 26, and it is the one cause an operator can act on: `connect.ts`'s manifest only decides the events of Apps created AFTER it, so an App that already exists hears no `workflow_run` until somebody subscribes it by hand — and an unsubscribed event has no 403 to name it with, it simply never arrives.
  it('names the workflow_run subscription as the thing to check', async () => {
    overdue = [release()];
    await nameOverdueRunnerReleases(NOW);
    const failure = String(settled.get('rel-1')?.failure);
    expect(failure).toContain('`workflow_run` delivery');
    expect(failure).toContain('never polls');
    expect(failure).toContain('Subscribe to events');
  });

  it('says the tag exists and nothing is published', async () => {
    overdue = [release({ publication: 'unread' })];
    await nameOverdueRunnerReleases(NOW);
    expect(String(settled.get('rel-1')?.failure)).toContain('`runner-v0.13.3` exists at abc1234');
  });
});

describe('a process that died mid-sequence', () => {
  // cm:guard this is the row ISS-1075 point 3 is most about: no delivery will ever arrive for it, so without this pass it stays in flight forever and the tag is found by accident.
  it('names a cut whose answer never came, and says the tag may exist', async () => {
    overdue = [release({ step: 'cut_tag', tagState: 'unknown' })];
    await nameOverdueRunnerReleases(NOW);
    const failure = String(settled.get('rel-1')?.failure);
    expect(settled.get('rel-1')?.step).toBe('cut_tag');
    expect(failure).toContain('stopped at `cut_tag` 95 minutes ago');
    expect(failure).toContain('may or may not exist');
    expect(failure).toContain('deletes none and re-cuts none');
  });

  it('names a preflight that stopped, and says nothing was written', async () => {
    overdue = [release({ step: 'check_lockfile_version', tagState: 'absent' })];
    await nameOverdueRunnerReleases(NOW);
    const failure = String(settled.get('rel-1')?.failure);
    expect(failure).toContain('stopped at `check_lockfile_version`');
    expect(failure).toContain('Nothing was written to the repository');
  });

  it('reaches a row that never got past its first step', async () => {
    overdue = [release({ step: 'resolve_commit', tagState: 'absent' })];
    expect(await nameOverdueRunnerReleases(NOW)).toEqual({ named: 1 });
  });
});

describe('what this pass may not decide', () => {
  // cm:guard it knows only that nobody said anything, so writing a `tagState` here would be inventing the very reading the row is honest about not having.
  it('writes no tag state of its own', async () => {
    overdue = [release({ tagState: 'unknown' }), release({ id: 'rel-2', tagState: 'absent' })];
    await nameOverdueRunnerReleases(NOW);
    expect(settled.get('rel-1')).not.toHaveProperty('tagState');
    expect(settled.get('rel-2')).not.toHaveProperty('tagState');
  });

  it('counts only the rows it actually settled', async () => {
    overdue = [release(), release({ id: 'rel-2' })];
    settled.set('rel-2', { already: true });
    expect(await nameOverdueRunnerReleases(NOW)).toEqual({ named: 1 });
  });

  it('skips a row whose write threw and still names the rest', async () => {
    overdue = [release({ id: 'explodes' }), release({ id: 'rel-2' })];
    expect(await nameOverdueRunnerReleases(NOW)).toEqual({ named: 1 });
    expect(settled.has('rel-2')).toBe(true);
    expect(logged.some((l) => l.releaseId === 'explodes')).toBe(true);
  });

  it('names nothing when nothing is overdue', async () => {
    expect(await nameOverdueRunnerReleases(NOW)).toEqual({ named: 0 });
    expect(settleFailed).not.toHaveBeenCalled();
  });
});

describe('the window itself', () => {
  // cm:guard a deadline under the build's own worst case turns this pass from the thing that finds an abandoned release into the thing that fails a live one: `runner-release.yml` runs a Rust check job, then a two-OS matrix, then the publish.
  it('clears the whole workflow rather than its median run', () => {
    expect(RUNNER_RELEASE_DEADLINE_MS).toBeGreaterThanOrEqual(60 * 60_000);
    expect(RUNNER_RELEASE_DEADLINE_MS).toBeLessThanOrEqual(6 * 60 * 60_000);
  });

  it('reports the wait in whole minutes, never as zero', async () => {
    overdue = [release({ startedAt: new Date(NOW.getTime() - 20_000) })];
    await nameOverdueRunnerReleases(NOW);
    expect(String(settled.get('rel-1')?.failure)).toContain('1 minutes ago');
  });
});
