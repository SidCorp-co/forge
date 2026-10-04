import { describe, expect, it } from 'vitest';
import { at, ctx, facts, job, jobLane, session } from './standing.fixture.js';
import { runStandingOf } from './standing.js';

describe('the holder clocks', () => {
  it('a deploy lock is the first clock, then the claim, then the silence reap', () => {
    const lease = { holder: 'iss-7-abc', renewedAt: at(-5).toISOString(), minutes: 60 };
    const r = runStandingOf(
      facts({
        workState: { step: 'build', stepStartedAt: at(-10), lease },
        deployLocks: [
          {
            environment: 'preview',
            subject: 'v1',
            acquiredAt: at(-3),
            expiresAt: at(-1),
            reclaimedFromRunId: null,
            held: true,
          },
        ],
      }),
      ctx(),
    );
    expect(r.holder).toMatchObject({
      source: 'held',
      expirySource: 'deploy_lock',
      verdict: 'expired',
    });
    if (r.holder.source !== 'held') throw new Error('held');
    expect(r.holder.expiries.map((e) => e.source)).toEqual([
      'deploy_lock',
      'claim',
      'silence_reap',
    ]);
    expect(r.holder.expiries[1]).toMatchObject({ at: at(55).toISOString(), verdict: 'live' });
  });

  it('a run session silent past 10 min reads abandoned on the silence reap', () => {
    const r = runStandingOf(facts({ session: session({ lastHeartbeatAt: at(-12) }) }), ctx());
    expect(r.holder).toMatchObject({
      expirySource: 'silence_reap',
      verdict: 'abandoned',
      expiresAt: at(-2).toISOString(),
    });
  });

  it('dispatchedBy names the pass when one spans the open, and says why when none does', () => {
    const withPass = runStandingOf(
      facts({ pass: { id: 'p-1', verb: 'dispatch', startedAt: at(-31) } }),
      ctx(),
    );
    expect(withPass.holder).toMatchObject({
      dispatchedBy: { source: 'pass', passId: 'p-1', masterSessionId: 'm-1' },
    });
    const noPass = runStandingOf(facts(), ctx());
    expect(noPass.holder).toMatchObject({ dispatchedBy: { source: 'master', passId: null } });
    const root = runStandingOf(facts({ master: null }), ctx());
    expect(root.holder).toMatchObject({ dispatchedBy: { source: 'none' } });
    expect(root.master).toMatchObject({ source: 'none' });
  });
});

describe('a job clock is the clock its owning reaper keeps', () => {
  it('a running job session is failed at its last beat + the heartbeat timeout', () => {
    const r = runStandingOf(jobLane(job({ sessionBeat: at(-4) })), ctx());
    expect(r.holder).toMatchObject({
      expirySource: 'silence_reap',
      expiresAt: at(-1).toISOString(),
      verdict: 'abandoned',
    });
  });

  it('a session awaiting input runs no silence clock, and says the reaper exempts it', () => {
    const r = runStandingOf(
      jobLane(job({ sessionBeat: at(-30), sessionRuntimeState: 'awaiting_input' })),
      ctx(),
    );
    expect(r.holder).toMatchObject({ source: 'held', expiresAt: null, expirySource: null });
    if (r.holder.source !== 'held') throw new Error('held');
    expect(r.holder.expiryDetail).toMatch(/awaiting input/);
  });

  it('an unacked dispatch is failed at dispatch + ackMs + the kill grace, not on the heartbeat timeout', () => {
    const r = runStandingOf(
      jobLane(job({ status: 'dispatched', ackedAt: null, hasEvents: false, dispatchedAt: at(-1) })),
      ctx(),
    );
    expect(r.holder).toMatchObject({
      expirySource: 'silence_reap',
      expiresAt: new Date(at(1).getTime() + 90_000).toISOString(),
      verdict: 'live',
    });
  });

  it('a dispatched job whose session is not running yet names why no clock runs', () => {
    const r = runStandingOf(
      jobLane(job({ status: 'dispatched', sessionStatus: 'queued', sessionBeat: null })),
      ctx(),
    );
    if (r.holder.source !== 'held') throw new Error('held');
    expect(r.holder.expiresAt).toBeNull();
    expect(r.holder.expiryDetail).toMatch(/session is queued/);
  });
});
