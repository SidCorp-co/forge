/**
 * ISS-1189 — the refusal at the door a verdict is actually written through.
 *
 * `criteria-verdicts.ts` only READS these records, after the run that wrote one has gone. The
 * refusal has to land where the write does, which is `screenAgentComment`: it already holds the
 * projectId and the parsed record, so the shape rule costs no second parse and no second read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let declaredShape = 'local';
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../db/schema.js', () => ({ projects: {} }));
vi.mock('../messaging/gather.js', () => ({ gatherFacts: async () => ({}) }));
vi.mock('../messaging/screen.js', () => ({ screenMessage: () => ({ ok: true }) }));
vi.mock('../messaging/record-screen.js', () => ({
  recordRefusals: async () => [],
  recordInCommentRefusal: () => null,
  recordInCommentWarning: () => null,
}));
vi.mock('../issues/skip-reason.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const criteriaOf = real.criteriaSkippedForNoDeployment as (r: unknown) => number[];
  const refusalOf = real.localPreviewSkipRefusal as (c: number[]) => unknown;
  return {
    ...real,
    verdictShapeRefusals: async (_projectId: string, record: unknown) => {
      const criteria = criteriaOf(record);
      if (criteria.length === 0 || declaredShape !== 'local') return [];
      return [refusalOf(criteria)];
    },
  };
});

const { screenAgentComment } = await import('./screen.js');
const { MessageRefusedError } = await import('../messaging/contract.js');

/** The record ISS-1152's judging run wrote for c13, in the layout `forge record verdict` writes. */
const SKIPPED_FOR_WANT_OF_A_DEPLOYMENT = [
  '## Judged',
  '',
  '```forge-record',
  'criterion: 13',
  'verdict: skipped',
  'commit: 382502c884',
  'evidence: 382502c884',
  'why: No route, same cause as 12: there is no deployment containing this change for a judging',
  '  run to exercise, so no derived commit could be cited.',
  '```',
  '',
  '`forge-record: verdict · contract 1`',
].join('\n');

const SKIPPED_FOR_WANT_OF_A_BINARY = SKIPPED_FOR_WANT_OF_A_DEPLOYMENT.replace(
  'why: No route, same cause as 12: there is no deployment containing this change for a judging\n  run to exercise, so no derived commit could be cited.',
  'why: No route at the deployment identity. These four are properties of the forge-runner daemon\n  and CLI, a separately installed binary that the identity I was given does not name.',
);

async function refusalFrom(body: string): Promise<string | null> {
  try {
    await screenAgentComment('a-project', body, {} as never);
    return null;
  } catch (err) {
    if (!(err instanceof MessageRefusedError)) throw err;
    return err.refusals.map((r) => `${r.rule}: ${r.why}`).join(' ');
  }
}

describe('a criterion parked for want of a deployment, on a project with no deployed preview', () => {
  beforeEach(() => {
    declaredShape = 'local';
  });

  it('is refused rather than stored', async () => {
    expect(await refusalFrom(SKIPPED_FOR_WANT_OF_A_DEPLOYMENT)).toContain(
      'skip-reason-local-preview',
    );
  });

  it('names the criterion it refused', async () => {
    expect(await refusalFrom(SKIPPED_FOR_WANT_OF_A_DEPLOYMENT)).toContain('criterion 13');
  });

  it('names local as the route to that criterion', async () => {
    expect(await refusalFrom(SKIPPED_FOR_WANT_OF_A_DEPLOYMENT)).toContain('LOCAL IS THE PREVIEW');
  });

  it('leaves a criterion parked for want of a separately installed binary alone', async () => {
    expect(await refusalFrom(SKIPPED_FOR_WANT_OF_A_BINARY)).toBeNull();
  });

  it('stores the same record on a project that declares a deployed preview', async () => {
    declaredShape = 'deployed';
    expect(await refusalFrom(SKIPPED_FOR_WANT_OF_A_DEPLOYMENT)).toBeNull();
  });
});
