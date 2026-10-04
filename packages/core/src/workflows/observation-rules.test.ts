import { describe, expect, it } from 'vitest';
import { observationRefusals } from './observation-rules.js';
import type { WriteObservation } from './observation-schema.js';

type Step = WriteObservation['steps'][number];

const SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';
const cited = (symbol = 'writeRevision') =>
  ({ kind: 'repo', file: 'packages/core/src/requirements/service.ts', symbol }) as const;

const base = (): WriteObservation => ({
  atSha: SHA,
  steps: [
    { id: 'drafted', matches: 'drafted', does: 'writes a revision', after: [], evidence: cited() },
    {
      id: 'obs-repin',
      matches: null,
      does: 're-pins a baseline',
      after: [],
      evidence: cited('repinRequirement'),
    },
  ],
  edges: [{ from: 'drafted', to: 'obs-repin', evidence: cited('repinRequirement') }],
});

const codes = (w: WriteObservation, planned = ['drafted', 'agreed']) =>
  observationRefusals({
    write: w,
    planned: new Set(planned),
    revision: 2,
    flow: 'requirement-to-delivery',
    source: { kind: 'repo' },
  }).map((r) => `${r.code} ${r.path}`);

describe('an observation write', () => {
  it('is accepted when every node and edge cites a file and symbol and matches a planned step or none', () => {
    expect(codes(base())).toEqual([]);
  });

  it.each([
    [
      'a step citing nothing',
      (w: WriteObservation) => ((w.steps[0] as { evidence: unknown }).evidence = null),
      'WORKFLOW_OBSERVATION_UNCITED /steps/0/evidence',
    ],
    [
      'a step citing a file and no symbol',
      (w: WriteObservation) => ((w.steps[0] as Step).evidence = { kind: 'repo', file: 'a.ts' }),
      'WORKFLOW_OBSERVATION_UNCITED /steps/0/evidence',
    ],
    [
      'a line number in place of a symbol',
      (w: WriteObservation) => ((w.steps[0] as Step).evidence = cited('L120')),
      'WORKFLOW_OBSERVATION_UNCITED /steps/0/evidence',
    ],
    [
      'a file carrying a line',
      (w: WriteObservation) =>
        ((w.steps[0] as Step).evidence = { kind: 'repo', file: 'a.ts:120', symbol: 'x' }),
      'WORKFLOW_OBSERVATION_UNCITED /steps/0/evidence',
    ],
    [
      'an edge citing nothing',
      (w: WriteObservation) => {
        (w.edges?.[0] as { evidence: unknown }).evidence = null;
      },
      'WORKFLOW_OBSERVATION_UNCITED /edges/0/evidence',
    ],
    [
      'a match the revision does not hold',
      (w: WriteObservation) => ((w.steps[1] as Step).matches = 'nowhere'),
      'WORKFLOW_OBSERVATION_MATCH_UNKNOWN /steps/1/matches',
    ],
    [
      'two steps matching one planned step',
      (w: WriteObservation) => ((w.steps[1] as Step).matches = 'drafted'),
      'WORKFLOW_OBSERVATION_MATCH_DUPLICATE /steps/1/matches',
    ],
    [
      'an edge to no observed step',
      (w: WriteObservation) => {
        (w.edges?.[0] as { to: string }).to = 'agreed';
      },
      'WORKFLOW_OBSERVATION_EDGE_DANGLING /edges/0',
    ],
    [
      'a drift naming no observed step',
      (w: WriteObservation) => (w.drift = { steps: ['agreed'], reason: 'moved' }),
      'WORKFLOW_OBSERVATION_DRIFT_UNKNOWN /drift/steps/0',
    ],
  ])('refuses %s by name', (_name, plant, expected) => {
    const w = base();
    plant(w);
    expect(codes(w)).toEqual([expected]);
  });

  it('refuses a repository citation in a storefront project', () => {
    const refused = observationRefusals({
      write: base(),
      planned: new Set(['drafted']),
      revision: 1,
      flow: 'f',
      source: { kind: 'storefront', provider: 'autoflow' },
    }).map((r) => r.code);
    expect(new Set(refused)).toEqual(new Set(['WORKFLOW_OBSERVATION_CITATION_KIND_MISMATCH']));
  });
});
