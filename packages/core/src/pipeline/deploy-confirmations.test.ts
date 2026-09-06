/**
 * ISS-922 — the gate that decides whether a run has earned `completed`.
 *
 * `resolveDeployGate` is pure, so every axis is provable here without a
 * database: the happy path, the failure, the boundary at the deadline, the
 * partial fan-out, and the business rule itself (a run is proven only when
 * EVERY target is).
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why `resolveDeployGate` is pure but its module opens the db client at import time, so the stub is what keeps this suite free of a real environment.
vi.mock('../db/client.js', () => ({ db: {} }));

import {
  DEPLOY_CONFIRM_WINDOW_MS,
  type DeployHolds,
  dispatchHoldKey,
  resolveDeployGate,
  targetHoldKey,
} from './deploy-confirmations.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const future = new Date(NOW.getTime() + 60_000).toISOString();
const past = new Date(NOW.getTime() - 1).toISOString();

function hold(over: Partial<DeployHolds[string]> = {}): DeployHolds[string] {
  return {
    bindingId: 'bind-1',
    deploymentUuid: 'dep-1',
    targetLabel: 'Backend',
    status: 'pending',
    deadlineAt: future,
    ...over,
  };
}

describe('resolveDeployGate', () => {
  it('is clear when no deploy was ever dispatched for the run', () => {
    expect(resolveDeployGate({}, NOW)).toEqual({ verdict: 'clear' });
  });

  it('is clear once every target succeeded', () => {
    const holds = {
      a: hold({ status: 'succeeded' }),
      b: hold({ status: 'succeeded', targetLabel: 'Frontend' }),
    };
    expect(resolveDeployGate(holds, NOW)).toEqual({ verdict: 'clear' });
  });

  it('DEFERS while one of two targets is still in flight — the run is not proven by half a deploy', () => {
    const holds = {
      a: hold({ status: 'succeeded' }),
      b: hold({ status: 'pending', targetLabel: 'Frontend' }),
    };
    expect(resolveDeployGate(holds, NOW)).toEqual({ verdict: 'defer', confirmed: 1, total: 2 });
  });

  it('FAILS on a reported failure, and names the target and the reason', () => {
    const holds = {
      a: hold({ status: 'succeeded' }),
      b: hold({ status: 'failed', targetLabel: 'Frontend', detail: 'coolify reported failed' }),
    };
    expect(resolveDeployGate(holds, NOW)).toEqual({
      verdict: 'failed',
      detail: 'Frontend: coolify reported failed',
    });
  });

  it('a reported failure outranks a sibling still in flight — the run does not wait to fail', () => {
    const holds = { a: hold({ status: 'pending' }), b: hold({ status: 'failed' }) };
    expect(resolveDeployGate(holds, NOW).verdict).toBe('failed');
  });

  it('FAILS an unconfirmed deploy once its deadline passes, naming the deployment', () => {
    const holds = { a: hold({ deadlineAt: past }) };
    expect(resolveDeployGate(holds, NOW)).toEqual({
      verdict: 'failed',
      detail: 'Backend (dep-1) unconfirmed',
    });
  });

  it('names the missing deployment_uuid when the dispatch never got one', () => {
    const holds = { a: hold({ deadlineAt: past, deploymentUuid: null }) };
    expect(resolveDeployGate(holds, NOW)).toEqual({
      verdict: 'failed',
      detail: 'Backend (no deployment_uuid) unconfirmed',
    });
  });

  // cm:guard the boundary is `<=`, so a hold whose deadline is exactly now is EXPIRED. A `<` here turns the last millisecond of the window into a defer that the next tick resolves anyway — harmless — but the test exists so the direction is a decision and not an accident.
  it('the deadline boundary is inclusive: deadlineAt === now is expired, one ms later is not', () => {
    expect(resolveDeployGate({ a: hold({ deadlineAt: NOW.toISOString() }) }, NOW).verdict).toBe(
      'failed',
    );
    expect(
      resolveDeployGate({ a: hold({ deadlineAt: new Date(NOW.getTime() + 1).toISOString() }) }, NOW)
        .verdict,
    ).toBe('defer');
  });

  it('is bounded: the window is shorter than the sweeper quiet window it must resolve inside', () => {
    // cm:edge contract -> packages/core/src/jobs/loop-monitor.ts — RESULT_QUIET_MINUTES is 60 minutes; raise this window past it and the sweeper and the deploy gate both decide one run's outcome, which is the two-writers shape ISS-923 forbids.
    expect(DEPLOY_CONFIRM_WINDOW_MS).toBeLessThan(60 * 60_000);
  });
});

describe('hold keys', () => {
  it('a dispatch placeholder and a real target hold never collide', () => {
    expect(dispatchHoldKey('req-1')).not.toBe(targetHoldKey('req-1'));
  });
});
