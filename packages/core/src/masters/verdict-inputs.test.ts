import { masterFactsSchema } from '@forge/contracts/master-verdict';
import { saidDisagreements, sayEn } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  type MasterJudged,
  masterVerdict as masterVerdict_,
  outdatedWhy as outdatedWhy_,
} from './verdict.js';

/** Every verdict's English is the sentence it says (`saidDisagreements`). */
const masterVerdict = ((...a: Parameters<typeof masterVerdict_>) => {
  const v = masterVerdict_(...a);
  expect(saidDisagreements(v)).toEqual([]);
  return v;
}) as typeof masterVerdict_;

const outdatedWhy = (...a: Parameters<typeof outdatedWhy_>) => {
  const w = outdatedWhy_(...a);
  return w === null ? null : sayEn(w);
};

function alive(over: Partial<MasterJudged> = {}): MasterJudged {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'alive',
    capability: 'current',
    serversReadable: true,
    work: { admissible: 1, owed: 0, poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1', transcript: 'present', elsewhere: 'none' },
    placement: null,
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: { doing: 'idle', lastEvent: 'stop', lastEventAgoSeconds: 0 },
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { digest: 'd1', last: null, since: 'unreported' },
    ...over,
  };
}

const online = { runnerStatus: 'online', passOpen: false };
const holds = (live: string[]): MasterJudged['holding'] => ({
  kind: 'these',
  runs: live.map((name) => ({ name, subagent: { kind: 'resumed' as const, silentMs: 0 } })),
});
const noWork = { admissible: 0, owed: 0, poolWaits: false, jobPanes: 0 };

// forge-dev 2026-10-07: the dev runner was rebuilt six times in three hours (dev.62..71), and every
// rebuild read every master "placed under runner X, this box runs Y", so a busy master drained and
// was refused new runs (ISS-275/280 waited ~25 min) though nothing it runs on had changed.
describe('outdated: by what the pane runs on, not by the runner build, and judged by core alone', () => {
  const handed = {
    wire: '1',
    skill: 'aaaaaaaaaaaa',
    hooks: 'bbbbbbbbbbbb',
    env: 'cccccccccccc',
    mcp: 'dddddddddddd',
    launch: 'eeeeeeeeeeee',
  };
  const placement = (placed: Record<string, string> | null, now: Record<string, string>) => ({
    placement: { placed, unreadable: null, now },
  });
  const busy = { work: { ...noWork, admissible: 2 }, holding: holds(['r9 (ISS-280)']) };

  it('a rebuild that changes no input leaves a busy master current: kept, not drained', () => {
    const v = masterVerdict(alive({ ...busy, ...placement(handed, { ...handed }) }), online);
    expect(v).toMatchObject({ act: 'keep', drain: false });
    expect(v.because).not.toContain('outdated');
  });

  it('a changed skill text is outdated, drains, and names the input', () => {
    const now = { ...handed, skill: 'ffffffffffff' };
    const v = masterVerdict(alive({ ...busy, ...placement(handed, now) }), online);
    expect(v).toMatchObject({ act: 'keep', drain: true });
    expect(v.because).toContain(
      'what it runs on changed since it was placed: skill (placed aaaaaaaaaaaa, now ffffffffffff)',
    );
  });

  it('a changed input with nothing held replaces it, naming every input that changed', () => {
    const now = { ...handed, wire: '2', env: '000000000000' };
    const v = masterVerdict(alive({ ...placement(handed, now) }), online);
    expect(v).toMatchObject({ act: 'replace', reason: 'outdated' });
    expect(v.because).toContain(
      'env (placed cccccccccccc, now 000000000000); wire (placed 1, now 2)',
    );
  });

  it('an input the box could not read now is no evidence of a change', () => {
    const { mcp: _unread, ...now } = handed;
    expect(outdatedWhy(placement(handed, now))).toBeNull();
  });

  it('a pane with no placement read, or none the box could judge, is not outdated', () => {
    expect(outdatedWhy({ placement: null })).toBeNull();
  });

  it('a pane the box holds no record for, or cannot read the record of, is outdated by name', () => {
    expect(outdatedWhy(placement(null, handed))).toContain(
      'holds no record of what it was placed with',
    );
    const unreadable = { placement: { placed: null, unreadable: 'not json', now: handed } };
    expect(outdatedWhy(unreadable)).toContain('(not json), so whether it runs on');
    expect(masterVerdict(alive({ ...busy, ...placement(null, handed) }), online)).toMatchObject({
      act: 'keep',
      drain: true,
    });
  });

  it('the facts body takes the placement as the box sends it and refuses a malformed one or the old fields', () => {
    const body = masterFactsSchema.shape.placement;
    const ok = (v: unknown) => body.safeParse(v).success;
    expect(ok({ placed: handed, unreadable: null, now: handed })).toBe(true);
    expect(ok({ placed: null, unreadable: 'x', now: handed })).toBe(true);
    expect(ok(null)).toBe(true);
    expect(ok(undefined)).toBe(false);
    expect(ok({ placed: { 'Bad Name': 'x' }, unreadable: null, now: handed })).toBe(false);
    expect(ok({ placed: handed, unreadable: null, now: { skill: '' } })).toBe(false);
    expect(ok({ placed: handed, now: handed })).toBe(false);
    const { placement: _p, ...rest } = alive();
    const old = { ...rest, outdated: 'placed under runner 1, and this box runs 2 now' };
    expect(masterFactsSchema.safeParse(old).success).toBe(false);
  });
});
