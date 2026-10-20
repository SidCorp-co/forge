/** ISS-1228 round 19: the capacity notice names why an online runner cannot take the step. */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { capacityBarOf, fleetCopy, fleetOf } = await import('./capacity-fleet.js');

const ready = {
  silent: false,
  disabled: false,
  inPool: true,
  capable: true,
  workspaceReady: true,
  claimCapable: true,
  limited: false,
};
const scope = { scope: 'this project' };

describe('what keeps an online runner from a step', () => {
  it.each([
    [{ silent: true, disabled: true }, 'silent'],
    [{ disabled: true, workspaceReady: false }, 'disabled'],
    [{ inPool: false, capable: false }, 'outside_pool'],
    [{ capable: false, workspaceReady: false }, 'lacking'],
    [{ workspaceReady: false, limited: true }, 'workspace'],
    [{ claimCapable: false, limited: true }, 'too_old'],
    [{ limited: true }, 'limited'],
    [{}, null],
  ])('reads %j as %s, the first bar a person fixes', (checks, bar) => {
    expect(capacityBarOf({ ...ready, ...checks })).toBe(bar);
  });
});

describe('the capacity notice beside an online runner', () => {
  it('never says no runner is online while one is: two online runners with no workspace are named', () => {
    const copy = fleetCopy(
      fleetOf([
        { ...ready, workspaceReady: false },
        { ...ready, workspaceReady: false },
      ]),
      scope,
    );
    expect(copy?.title).toBe('No runner can take this work for this project');
    expect(copy?.summary).toContain(
      'Both of its runners are online, but both are without a workspace ready',
    );
    expect(`${copy?.title} ${copy?.summary}`).not.toMatch(/no runner online/i);
  });

  it('names each bar of a mixed fleet with its count', () => {
    const copy = fleetCopy(
      fleetOf([
        { ...ready, disabled: true },
        { ...ready, capable: false },
        { ...ready, capable: false },
      ]),
      scope,
    );
    expect(copy?.summary).toContain(
      'All 3 of its runners are online, but one is turned off, and 2 are missing a capability',
    );
  });

  it('names a box online whose runner never checked in for the project', () => {
    expect(fleetCopy(fleetOf([{ ...ready, silent: true }]), scope)?.summary).toContain(
      'Its one runner is online, but it is not yet checked in for this project',
    );
  });

  // ISS-1228 r20, judge-62: the next step offered a workspace and a turn-on for an old build and a limit.
  it('names a fix for each bar it named, and none for a bar it did not', () => {
    const copy = fleetCopy(
      fleetOf([
        { ...ready, claimCapable: false },
        { ...ready, limited: true },
      ]),
      scope,
    );
    expect(copy?.summary).toContain('one is running a build too old to take work, and one is held back by an account limit');
    expect(copy?.nextStep).toBe(
      "Open this project's Runners tab, then update the runner on an old build, and wait for the account limit to lift, or sign the limited runner in to an account with room.",
    );
    expect(copy?.nextStep).not.toMatch(/workspace|back on/);
  });

  it('says each fix of several runners in the plural', () => {
    const copy = fleetCopy(
      fleetOf([
        { ...ready, workspaceReady: false },
        { ...ready, workspaceReady: false },
      ]),
      scope,
    );
    expect(copy?.nextStep).toBe(
      "Open this project's Runners tab, then finish the workspace of the runners without one.",
    );
  });

  it.each([
    ['nothing online', []],
    ['every runner limited', [{ ...ready, limited: true }]],
    ['every runner out of date', [{ ...ready, claimCapable: false }]],
  ])('leaves %s to the notice that already says it', (_name, rows) => {
    expect(fleetCopy(fleetOf(rows), scope)).toBeNull();
  });
});
