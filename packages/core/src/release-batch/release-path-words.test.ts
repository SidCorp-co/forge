/**
 * ISS-1421 round 3 — every sentence that tells a reader where a release starts is short and whole:
 * judge-29 read the ships-nothing one as a broken clause. Each shape, each status and each hold is
 * walked here, and every sentence it yields must open with a capital, end with a full stop and run
 * to at most 25 words. The words themselves are proved where they are read, in `releasing-door`.
 */

import { describe, expect, it } from 'vitest';
import type { IssueStatus } from '../db/schema.js';
import {
  type GateHolds,
  NO_DOORS,
  nextAtGateFor,
  type ReleaseDoors,
  type ReleasePath,
  releaseStartsFor,
} from './release-path-words.js';

const PATHS: ReleasePath[] = ['gated', 'ships-nothing', 'no-live-target', 'unread'];
const FROM: IssueStatus[] = ['awaiting_release', 'testing', 'open'];
const HOLDS: GateHolds[] = [
  { kind: 'read', holds: [] },
  {
    kind: 'read',
    holds: [
      {
        reason: 'not marked merged',
        clears: "Use Mark merged in the issue's properties, and fill in Where it landed.",
      },
    ],
  },
  {
    kind: 'read',
    holds: [
      {
        reason: 'no mark naming where its work landed',
        clears:
          "Use Mark merged in the issue's properties, and give Where it landed its landing: the live URL, CMS entry or storefront resource.",
      },
      {
        reason: 'holds 2 open questions',
        clears: 'Answer them in their "Decision waiting" cards on the issue\'s page.',
      },
      {
        reason:
          'missing a plan, acceptance criteria and a release note, which this project requires before a close',
        clears: "The agent working this issue writes them, through Forge's issue tools.",
      },
    ],
  },
  { kind: 'unread' },
];

const DOORS: ReleaseDoors[] = [
  NO_DOORS,
  {
    addLiveTarget:
      'https://forge.example/projects/acme/settings?tab=integrations&add=live-deploy-target',
  },
];

const MAX_WORDS = 25;

function faultsOf(sentence: string): string[] {
  const faults: string[] = [];
  if (!/^[A-Z`]/.test(sentence)) faults.push('does not open with a capital');
  if (!/[.]$/.test(sentence)) faults.push('does not end with a full stop');
  const words = sentence.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) faults.push(`runs to ${words} words`);
  return faults;
}

function everySentence(): Array<{ where: string; sentence: string }> {
  const out: Array<{ where: string; sentence: string }> = [];
  for (const path of PATHS) {
    for (const holds of HOLDS) {
      for (const doors of DOORS) {
        const said = JSON.stringify({ holds, doors });
        for (const sentence of nextAtGateFor(path, holds, doors)) {
          out.push({ where: `nextAtGateFor(${path}, ${said})`, sentence });
        }
        for (const from of FROM) {
          for (const sentence of releaseStartsFor(path, 'proj-7', from, holds, doors)) {
            out.push({ where: `releaseStartsFor(${path}, ${from}, ${said})`, sentence });
          }
        }
      }
    }
  }
  return out;
}

describe('release-path sentences (ISS-1421 round 3)', () => {
  it('are each a short whole sentence', () => {
    const faulty = everySentence()
      .map(({ where, sentence }) => ({ where, sentence, faults: faultsOf(sentence) }))
      .filter((s) => s.faults.length > 0);
    expect(faulty).toEqual([]);
  });

  it('name Release now to a gated issue at the gate only where nothing holds it', () => {
    const [none, held, combined, unread] = HOLDS as [GateHolds, GateHolds, GateHolds, GateHolds];
    expect(releaseStartsFor('gated', 'proj-7', 'awaiting_release', none).join(' ')).toContain(
      'Start one with Release now',
    );
    for (const holds of [held, combined, unread]) {
      expect(
        releaseStartsFor('gated', 'proj-7', 'awaiting_release', holds).join(' '),
      ).not.toContain('Start one with Release now');
      expect(nextAtGateFor('gated', holds).join(' ')).not.toContain('starts a release');
    }
  });

  it('send a project with no live target to the place that adds one, by its address (r4)', () => {
    const [, linked] = DOORS as [ReleaseDoors, ReleaseDoors];
    const said = nextAtGateFor('no-live-target', undefined, linked).join(' ');
    expect(said).toContain(
      'Settings, on the Integrations tab. There, share a connection as Deploy target, with Live ticked.',
    );
    expect(said).toContain(`It opens at ${linked.addLiveTarget}.`);
    expect(nextAtGateFor('no-live-target').join(' ')).not.toContain('It opens at');
  });

  it('a sentence that breaks the rule is caught', () => {
    expect(faultsOf("one can only once the project's Shape & release setting chooses")).toEqual([
      'does not open with a capital',
      'does not end with a full stop',
    ]);
    expect(faultsOf(`${'word '.repeat(30).trim()}.`)).toEqual([
      'does not open with a capital',
      'runs to 30 words',
    ]);
  });
});
