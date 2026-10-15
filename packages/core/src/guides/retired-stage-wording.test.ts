/**
 * ISS-1229 r4, carried by ISS-1133 — the staged job types are retired, so nothing an agent is told
 * describes one as a step an issue moves through: no guide body, no affordance row, no prompt fact.
 * A walk through them, a name followed by `step` or `stage`, a list of them followed by `steps`, and
 * a sentence conditioned on a staged project are each refused, naming where.
 */

import { describe, expect, it } from 'vitest';
import { RETIRED_JOB_TYPES } from '../db/job-vocabulary.js';
import { FORGE_FACTS, OPERATING_AFFORDANCES_TEXT } from '../prompt/facts/registry.js';
import { GUIDE_CONTENT } from './content.generated.js';

const MARK = '[`*_]*';
const NAME = `${MARK}(?:${RETIRED_JOB_TYPES.join('|')})${MARK}`;

/** What reads as a retired stage still running, each with the name a finding carries. */
const RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['a walk through retired stages', new RegExp(`${NAME}\\s*(?:→|->|=>)\\s*${NAME}`, 'iu')],
  [
    'a retired stage named as a step',
    new RegExp(
      `\\b${NAME}(?:\\s*(?:,|/|\\band\\b|\\bor\\b)\\s*${NAME})*\\s+(?:steps?|stages?)\\b`,
      'iu',
    ),
  ],
  ['a sentence about a staged project', /\b(?:on|in|for) a staged (?:project|pipeline)\b/iu],
];

function findings(texts: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [where, text] of texts) {
    for (const [rule, pattern] of RULES) {
      const hit = pattern.exec(text);
      if (hit) out.push(`${where}: ${rule} — "${hit[0]}"`);
    }
  }
  return out;
}

describe('no retired stage is described as running', () => {
  it('in a guide body, the affordance table or a prompt fact', () => {
    expect(
      findings([
        ...Object.entries(GUIDE_CONTENT).map(([slug, body]) => [`guide ${slug}`, body] as const),
        ['operating affordances', OPERATING_AFFORDANCES_TEXT],
        ...FORGE_FACTS.map((f) => [`fact ${f.id}`, f.render()] as const),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['those are written by the clarify and plan steps', 'a retired stage named as a step'],
    ['owned by the `plan` stage', 'a retired stage named as a step'],
    ['written by the clarify/plan steps', 'a retired stage named as a step'],
    ['that is the release step', 'a retired stage named as a step'],
    ['agents move it through triage → plan → code', 'a walk through retired stages'],
    ['**review** -> **test**', 'a walk through retired stages'],
    ['on a staged project `fix` re-enters', 'a sentence about a staged project'],
  ])('refuses "%s" as %s', (sentence, rule) => {
    expect(findings([['planted', sentence]])).toEqual([
      expect.stringContaining(`planted: ${rule}`),
    ]);
  });

  it('lets a live phase, a release batch and the word "stage" in its other senses through', () => {
    expect(
      findings([
        ['planted', "the driver's planning phase; a release batch ships it; stage the files"],
      ]),
    ).toEqual([]);
  });
});
