import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  DEAD_ON_ARRIVAL_SECONDS,
  type MasterJudged,
  masterVerdict as masterVerdict_,
} from './verdict.js';

/** Every verdict's English is the sentence it says (`saidDisagreements`). */
const masterVerdict = ((...a: Parameters<typeof masterVerdict_>) => {
  const v = masterVerdict_(...a);
  expect(saidDisagreements(v)).toEqual([]);
  return v;
}) as typeof masterVerdict_;

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

const online = { runnerStatus: 'online', passOpen: false, archivedAt: null };
// ISS-859: a pane placed and never heard from.
describe('dead on arrival: a placed pane that never reported', () => {
  const unheard = (over: Partial<NonNullable<MasterJudged['arrival']>> = {}) =>
    alive({
      placement: { placed: null, unreadable: null, now: {} },
      turn: { kind: 'unknown' },
      arrival: {
        pane: 'forge-master-catalog',
        placedAgoSeconds: DEAD_ON_ARRIVAL_SECONDS,
        heard: false,
        deadBefore: false,
        ...over,
      },
    });

  it('is ended and placed again once the window has passed, named', () => {
    const v = masterVerdict(unheard(), online);
    expect(v).toMatchObject({ act: 'replace', reason: 'dead_on_arrival', resume: 'conv-1' });
    expect(v.because).toContain('forge-master-catalog');
  });

  it('is waited on inside the window, and never once it was heard', () => {
    for (const over of [{ placedAgoSeconds: DEAD_ON_ARRIVAL_SECONDS - 1 }, { heard: true }]) {
      expect(masterVerdict(unheard(over), online)).not.toMatchObject({
        reason: 'dead_on_arrival',
      });
    }
  });

  it('a second dead arrival in a row is left and said, not placed again', () => {
    const v = masterVerdict(unheard({ deadBefore: true }), online);
    expect(v).toMatchObject({ act: 'leave', reason: 'dead_on_arrival' });
    expect(v.because).toContain('forge-master-catalog');
  });

  it('a box that sends no arrival is judged as before', () => {
    const { arrival: _, ...old } = unheard();
    expect(masterVerdict(old, online)).toMatchObject({ act: 'keep' });
  });
});
