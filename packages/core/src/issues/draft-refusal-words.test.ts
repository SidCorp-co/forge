import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { DRAFT_EXIT_TARGETS } from '../pipeline/state-machine.js';

// ISS-1421 r12 — moving an issue out of Draft to a status Draft cannot reach was refused on the
// status menu with "a Draft (draft) issue may only move to Open (open), …": a stored value beside
// every label, lower case, one sentence of 40 words. Each refusal here reads in labels, and the
// values a caller sends back stay in the refusal's details.

const read = { status: 'open', runs: 0, jobs: 0 };
vi.mock('../db/client.js', async () => {
  const schema = await vi.importActual<typeof import('../db/schema.js')>('../db/schema.js');
  const chain = (table: unknown) => ({
    where: () => ({
      limit: async () => {
        if (table === schema.issues) return [{ status: read.status }];
        return [{ n: table === schema.pipelineRuns ? read.runs : read.jobs }];
      },
    }),
  });
  return { db: { select: () => ({ from: (table: unknown) => chain(table) }) } };
});

const { assertIssueNeverEnteredPipeline, draftExitRefusal, explainDraftRace } = await import(
  './draft-entry.js'
);

function inWords(message: string): void {
  expect(message, message).not.toMatch(/\([a-z_]+\)/);
  for (const sentence of message.split(/(?<=\.)\s+/)) {
    expect(sentence, sentence).toMatch(/^[A-Z]/);
    expect(sentence, sentence).toMatch(/\.$/);
    expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(25);
  }
}

async function refusal(
  run: () => Promise<unknown>,
): Promise<{ message: string; details: unknown }> {
  try {
    const raced = await run();
    if (raced instanceof Error) return raced as never;
  } catch (err) {
    return err as never;
  }
  throw new Error('nothing was refused');
}

beforeEach(() => {
  read.status = 'open';
  read.runs = 0;
  read.jobs = 0;
});

describe('the Draft refusals read in labels', () => {
  it.each(issueStatuses.filter((s) => s !== 'draft' && !DRAFT_EXIT_TARGETS.includes(s)))(
    'leaving Draft for %s',
    (to) => {
      const said = draftExitRefusal(to);
      inWords(said);
      expect(said).toContain('Open, Closed, Dropped, Developed or In progress');
    },
  );

  it('going back to Draft after a run', async () => {
    read.runs = 2;
    read.jobs = 1;
    const err = await refusal(() => assertIssueNeverEnteredPipeline('i1', 'open'));
    inWords(err.message);
    expect(err.message).toContain('2 pipeline runs and 1 job');
    expect(err.details).toMatchObject({ from: 'open', to: 'draft', runCount: 2, jobCount: 1 });
  });

  it('a Draft move that lost its race to a status change', async () => {
    read.status = 'in_progress';
    const err = await refusal(() => explainDraftRace('i1', 'open', 'draft'));
    inWords(err.message);
    expect(err.details).toMatchObject({ observedStatus: 'in_progress' });
  });

  it('a Draft move that lost its race to a run', async () => {
    read.runs = 1;
    const err = await refusal(() => explainDraftRace('i1', 'open', 'draft'));
    inWords(err.message);
  });

  it('a Draft move that did not apply for no reason read', async () => {
    const err = await refusal(() => explainDraftRace('i1', 'open', 'draft'));
    inWords(err.message);
  });
});
