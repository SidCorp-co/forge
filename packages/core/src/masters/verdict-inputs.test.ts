import { masterFactsSchema } from '@forge/contracts/master-verdict';
import { describe, expect, it } from 'vitest';
import { type MasterJudged, masterVerdict, outdatedWhy } from './verdict.js';

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
    outdated: null,
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
describe('outdated: by what the pane runs on, not by the runner build', () => {
  const byBuild = 'placed under runner 0.4.0-dev.69, and this box runs 0.4.0-dev.71 now';
  const handed = {
    wire: '1',
    skill: 'aaaaaaaaaaaa',
    hooks: 'bbbbbbbbbbbb',
    env: 'cccccccccccc',
    mcp: 'dddddddddddd',
    launch: 'eeeeeeeeeeee',
  };
  const busy = { work: { ...noWork, admissible: 2 }, holding: holds(['r9 (ISS-280)']) };

  it('a rebuild that changes no input leaves a busy master current: kept, not drained', () => {
    const v = masterVerdict(
      alive({ ...busy, outdated: byBuild, inputs: { placed: handed, now: { ...handed } } }),
      online,
    );
    expect(v).toMatchObject({ act: 'keep', drain: false });
    expect(v.because).not.toContain('outdated');
  });

  it('a changed skill text is outdated, drains, and names the input', () => {
    const now = { ...handed, skill: 'ffffffffffff' };
    const v = masterVerdict(
      alive({ ...busy, outdated: byBuild, inputs: { placed: handed, now } }),
      online,
    );
    expect(v).toMatchObject({ act: 'keep', drain: true });
    expect(v.because).toContain(
      'what it runs on changed since it was placed: skill (placed aaaaaaaaaaaa, now ffffffffffff)',
    );
  });

  it('a changed input with nothing held replaces it, naming every input that changed', () => {
    const now = { ...handed, wire: '2', env: '000000000000' };
    const v = masterVerdict(alive({ outdated: byBuild, inputs: { placed: handed, now } }), online);
    expect(v).toMatchObject({ act: 'replace', reason: 'outdated' });
    expect(v.because).toContain(
      'env (placed cccccccccccc, now 000000000000); wire (placed 1, now 2)',
    );
  });

  it('an input the box could not read now is no evidence of a change', () => {
    const { mcp: _unread, ...now } = handed;
    expect(outdatedWhy({ outdated: byBuild, inputs: { placed: handed, now } })).toBeNull();
  });

  it('a box that reports no inputs, or a pane placed before they were recorded, is judged by its build as before', () => {
    expect(outdatedWhy({ outdated: byBuild })).toBe(byBuild);
    expect(outdatedWhy({ outdated: byBuild, inputs: null })).toBe(byBuild);
    expect(outdatedWhy({ outdated: byBuild, inputs: { placed: null, now: handed } })).toBe(byBuild);
    expect(masterVerdict(alive({ ...busy, outdated: byBuild }), online)).toMatchObject({
      act: 'keep',
      drain: true,
    });
  });

  it('the facts body takes inputs as the box sends them, takes none from an older box, and refuses a malformed one', () => {
    const inputs = masterFactsSchema.shape.inputs;
    expect(inputs.safeParse({ placed: handed, now: handed }).success).toBe(true);
    expect(inputs.safeParse({ placed: null, now: handed }).success).toBe(true);
    expect(inputs.safeParse(undefined).success).toBe(true);
    expect(inputs.safeParse(null).success).toBe(true);
    expect(inputs.safeParse({ placed: { 'Bad Name': 'x' }, now: handed }).success).toBe(false);
    expect(inputs.safeParse({ placed: handed, now: { skill: '' } }).success).toBe(false);
    expect(inputs.safeParse({ placed: handed }).success).toBe(false);
  });

  it('a pane the box reads current stays current whatever its inputs say', () => {
    const now = { ...handed, skill: 'ffffffffffff' };
    expect(outdatedWhy({ outdated: null, inputs: { placed: handed, now } })).toBeNull();
  });
});
