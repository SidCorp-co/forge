// @direct-test-of packages/contracts/src/
// @direct-test-of packages/contracts/src/suggestions.ts
// @direct-test-of packages/core/src/intake/prompt.ts
// @direct-test-of packages/core/src/onboarding/agent-writes.ts
// @direct-test-of packages/core/src/pipeline/step-handoff-schema.ts
// @direct-test-of packages/core/src/questionnaires/index.ts
// @direct-test-of packages/core/src/questionnaires/read.ts
// @direct-test-of packages/core/src/steward/door-ask.ts
// ISS-904 (owner, 2026-11-02, "lift the limits"; REQ-10 r7 BC-6, REQ-65 r3 BC-3, REQ-66 r3 BC-4,
// REQ-67 r2 BC-4): an agent asks the questions it needs, each with a recommended answer. No prompt,
// guide, tool description or refusal that asks a person something may put a count on those
// questions again. Each served guide is read as served, and the source of every module that asks is
// read whole, so a count written as a literal, a constant in a template or a comment all go red; and
// no route schema in core or contracts caps the array a question field holds.

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
    String.raw`\b(?:at most|up to|no more than)\s+${NUMBER}\s+(?:of (?:your |the )?)?(?:open |pending )?${ASKED}`,
    'i',
  ),
  // ISS-904 c1 on dev.706: 'A batch holds up to ${QUESTIONNAIRE_MAX_ITEMS} items' slipped the line
  // above, a card's questions counted by the card's own word for them (a verdict's evidence items
  // are no questions, so `items` counts only beside a card)
  new RegExp(
    String.raw`\b(?:card|batch|questionnaire)\b[^.\n]{0,30}\b(?:at most|up to|no more than)\s+${NUMBER}\s+items?\b`,
    'i',
  ),
  /\bone\s+(?:question|clarification|card|questionnaire card|batch)\b[^.\n]{0,40}\bat a time\b/i,
  // ISS-904 c1 on dev.703: 'Ask one short question at a time' (the widget) and 'ask the person one
  // short question' (the room agent's decide card and support.decide) slipped the line above
  /\bone\s+(?:short\s+|brief\s+|single\s+)?(?:question|clarification)\b[^.\n]{0,40}\bat a time\b/i,
  // a tool asking one question per call is no cap; one *short* question as the whole ask is
  /\bask(?:s|ing)?\b[^.\n]{0,30}\bone\s+(?:short|brief|single)\s+(?:question|clarification)\b/i,
  /\b(?:at most )?one is open (?:at a time|per)\b/i,
  // ISS-904 c1 on dev.701: the clarify tool still said 'Refused while one is open on the item'
  /\b(?:refused|refuses|wait)\b[^.\n]{0,20}\bwhile (?:one|a question|a clarification) is (?:open|pending|unanswered)\b/i,
  // ISS-904 c1 on dev.706: 'A card sent while another still waits is refused' (the BA's card tools)
  /\bwhile another\b[^.\n]{0,40}\b(?:is )?refused\b/i,
  /\b(?:STEWARD_ASK_LIMIT|STEWARD_OPEN_ASKS_MAX|FEEDBACK_CLARIFICATION_ALREADY_OPEN|CLARIFICATION_ALREADY_OPEN|ONBOARDING_QUESTIONS_OVER_CAP|ONBOARDING_MAX_QUESTIONS|QUESTIONNAIRE_ROUNDS_EXHAUSTED|QUESTIONNAIRE_MAX_ROUNDS|QUESTIONNAIRE_MAX_ITEMS|QUESTIONNAIRE_ALREADY_OPEN|INTAKE_QUESTIONS_MAX)\b/,
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
  'questions',
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
  'support.ts',
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

/**
 * A route schema caps the questions it carries when the array a question field holds is chained with
 * `.max(` (ISS-904 c1 on dev.708: a step handoff's `openQuestions` `.max(10)`, a requirement spec's
 * `.max(50)`). A card's `items` and `answers` are its questions only in the card's own sources. A
 * bound on each question's text, or on the list's bytes, is no count.
 */
const QUESTION_FIELDS = /\b(openQuestions|questions|asks|clarifications|unknowns)\??\s*[:=]\s*/g;
const CARD_FIELDS = /\b(items|answers)\??\s*[:=]\s*/g;
const CARD_SOURCES = /(?:contracts\/src\/onboarding\.ts|core\/src\/questionnaires\/)/;

/** The expression from `from` to its end, with every bracketed part emptied: `z.array().max()`. */
function outerChain(text: string, from: number): string {
  let depth = 0;
  let out = '';
  for (const c of text.slice(from)) {
    if (depth === 0 && (c === ',' || c === ';')) break;
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    if (depth < 0) break;
    if (depth === 0 || (depth === 1 && '([{'.includes(c))) out += c;
  }
  return out.replace(/\s+/g, '');
}

function cappedQuestionFields(path: string, text: string): string[] {
  const fields = CARD_SOURCES.test(path) ? [QUESTION_FIELDS, CARD_FIELDS] : [QUESTION_FIELDS];
  return fields.flatMap((field) =>
    [...text.matchAll(field)].flatMap((m) => {
      const chain = outerChain(text, (m.index ?? 0) + m[0].length);
      if (!/\.array\(/.test(chain) || !/\)\.max\(/.test(chain)) return [];
      return [`${path}:${text.slice(0, m.index).split('\n').length}: ${m[1]} ${chain}`];
    }),
  );
}

const SCHEMA_SOURCES = [...sourcesUnder(SRC), ...sourcesUnder(CONTRACTS)];

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
      `- A batch holds up to $${'{'}QUESTIONNAIRE_MAX_ITEMS} items, assumptions included; what does not fit goes in the next round.`,
      'A batch holds up to 15 items, assumptions included',
      'A card sent while another still waits is refused: ask the rest in the next round.',
      'refused QUESTIONNAIRE_ALREADY_OPEN',
    ]) {
      expect(countsIn(planted), planted).toHaveLength(1);
    }
    expect(countsIn('each with a recommended answer; options are 2-4 of {"id", "label"}')).toEqual(
      [],
    );
    // a bound on a card's payload is no count of what it asks
    expect(countsIn('(at least one item; 1048576 bytes of JSON at most)')).toEqual([]);
  });

  it('no route schema caps the questions a field carries', () => {
    expect(SCHEMA_SOURCES).toContain(join(SRC, 'pipeline/step-handoff-schema.ts'));
    expect(SCHEMA_SOURCES).toContain(join(CONTRACTS, 'suggestions.ts'));
    const found = SCHEMA_SOURCES.flatMap((path) =>
      cappedQuestionFields(relative(join(SRC, '../..'), path), readFileSync(path, 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('catches each shape a capped question field was written in', () => {
    for (const planted of [
      'openQuestions: z.array(z.string().min(1)).max(10),',
      '\topenQuestions: z.array(requirementOpenQuestionSchema).max(50).optional(),',
      'questions: z\n  .array(questionSchema)\n  .min(1)\n  .max(QUESTIONS_MAX),',
      'const unknowns = z.array(z.string()).max(5);',
    ]) {
      expect(cappedQuestionFields('src/any.ts', planted), planted).toHaveLength(1);
    }
    expect(
      cappedQuestionFields('contracts/src/onboarding.ts', 'items: z.array(item).max(15),'),
    ).toHaveLength(1);
    for (const left of [
      'openQuestions: z.array(z.string().min(1).max(2000)).refine(withinBytes),',
      'question: z.string().trim().min(5).max(2_000),',
      'options: z.array(option).min(2).max(8),',
      'items: z.array(label).max(50),',
    ]) {
      expect(cappedQuestionFields('src/any.ts', left), left).toEqual([]);
    }
  });
});
