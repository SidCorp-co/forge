// ISS-904 (owner, 2026-11-02, "lift the limits"; REQ-10 r7 BC-6, REQ-65 r3 BC-3, REQ-66 r3 BC-4,
// REQ-67 r2 BC-4): an agent asks the questions it needs, each with a recommended answer. No prompt,
// guide, tool description or refusal that asks a person something may put a count on those
// questions again. Each served guide is read as served, and the source of every module that asks is
// read whole, so a count written as a literal, a constant in a template or a comment all go red.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import { provideAssistantMethod } from '../guides/assistant-method-guide.js';
import { getGuide, listGuides } from '../guides/registry.js';

// what the composition root hands in at boot, so every guide is read as served
provideAssistantMethod(composeLayers(METHOD_LAYERS));

const NUMBER = String.raw`(?:\d+|\$\{[^}]+\}|one|two|three|four|five)`;
const ASKED =
  '(?:questions?|clarifications?|rounds?|(?:questionnaire )?cards?|batch(?:es)?|items of group question)';

/** The shapes a question count has been written in, each one a phrasing this repo carried. */
const COUNTS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:at most|up to|no more than)\s+${NUMBER}\s+(?:of (?:your |the )?)?${ASKED}`,
    'i',
  ),
  /\bone\s+(?:question|clarification|card|questionnaire card|batch)\b[^.\n]{0,40}\bat a time\b/i,
  /\b(?:at most )?one is open (?:at a time|per)\b/i,
  /\b(?:STEWARD_ASK_LIMIT|STEWARD_OPEN_ASKS_MAX|FEEDBACK_CLARIFICATION_ALREADY_OPEN|CLARIFICATION_ALREADY_OPEN|ONBOARDING_QUESTIONS_OVER_CAP|ONBOARDING_MAX_QUESTIONS|QUESTIONNAIRE_ROUNDS_EXHAUSTED|QUESTIONNAIRE_MAX_ROUNDS|INTAKE_QUESTIONS_MAX)\b/,
];

const countsIn = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => COUNTS.some((count) => count.test(line)))
    .map((line) => line.trim());

const SRC = new URL('..', import.meta.url).pathname;
const CONTRACTS = new URL('../../../contracts/src/', import.meta.url).pathname;

/** Every module that asks a person something: its prompts, tools, doors, guides and refusals. */
const ASKING_MODULES = [
  'assistant',
  'feedback',
  'guides',
  'intake',
  'mcp',
  'onboarding',
  'prompt',
  'questionnaires',
  'requirements',
  'steward',
  'support',
];
const ASKING_CONTRACTS = [
  'delivery-check.ts',
  'feedback.ts',
  'intake-drafts.ts',
  'onboarding.ts',
  'suggestions.ts',
];

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const SOURCES = [
  ...ASKING_MODULES.flatMap((m) => sourcesUnder(join(SRC, m))),
  ...ASKING_CONTRACTS.map((f) => join(CONTRACTS, f)),
];

describe('no question count returns to what asks a person (ISS-904)', () => {
  it('reads every asking module, so a moved file cannot pass by matching nothing', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    for (const file of ['steward/prompts.ts', 'feedback/rules.ts', 'onboarding/prompt.ts']) {
      expect(SOURCES).toContain(join(SRC, file));
    }
  });

  it('no served guide names a count of questions', () => {
    const found = listGuides().flatMap(({ slug }) =>
      countsIn(getGuide(slug)?.body ?? '').map((line) => `${slug}: ${line}`),
    );
    expect(found).toEqual([]);
  });

  it('no prompt, tool, door or refusal source names a count of questions', () => {
    const found = SOURCES.flatMap((path) =>
      countsIn(readFileSync(path, 'utf8')).map((line) => `${relative(SRC, path)}: ${line}`),
    );
    expect(found).toEqual([]);
  });

  it('catches each phrasing a count was written in', () => {
    for (const planted of [
      'asks at most three questions about it',
      `at most $${'{'}STEWARD_OPEN_ASKS_MAX} questions about the requirement`,
      'ask the reporter one clarification and wait: one question at a time per reporter',
      'At most one is open per item and per reporter',
      'One card is open on a requirement at a time',
      `This is round 2 of at most $${'{'}QUESTIONNAIRE_MAX_ROUNDS}.`,
      'up to 3 questions a round',
    ]) {
      expect(countsIn(planted), planted).toHaveLength(1);
    }
    expect(countsIn('each with a recommended answer; options are 2-4 of {"id", "label"}')).toEqual(
      [],
    );
  });
});
