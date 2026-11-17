// @direct-test-of packages/core/src/
// @direct-test-of packages/contracts/src/
// @direct-test-of packages/runner/crates/runner-workspace/assets/forge-master-skill.md
// @direct-test-of packages/runner/crates/forge-runner/src/cmd/question.rs
// @direct-test-of packages/web-v2/src/lib/i18n/copy/
// Only a file that speaks of asking can carry a question count (ISS-1262):
// @direct-test-when [Qq]uestion|QUESTION|[Cc]larif|CLARIF|\b[Aa]sk|\bASK|[Rr]ound|ROUND
// ISS-904 (owner, 2026-11-02, "lift the limits"; REQ-10 r7 BC-6, REQ-65 r3 BC-3, REQ-66 r3 BC-4,
// REQ-67 r2 BC-4): an agent asks the questions it needs, each with a recommended answer. No prompt,
// guide, card, tool description or refusal that asks a person something may put a count on those
// questions again, and no route schema may cap the list a question field holds.
// ISS-1262 (lesson L-106 kept being corrected): a fixed list of asking modules let a count through
// wherever the list stopped (the steward's triage prompt still said the clarification door "refuses
// by name while one of theirs is still open"). So this reads EVERY source of core and contracts,
// each guide as served, the tool list and the API as published, the skill and the asking CLI the
// runner ships, and the copy a person reads; and each find names its file, line and the phrase.

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

/**
 * The shapes a question count has been written in, each one a phrasing this repo carried. A tool
 * asking one question per call is no cap; one *short* question as the whole ask is. The reported
 * phrase is the first group where a pattern has one, else the whole match.
 */
const COUNTS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:at most|up to|no more than)\s+${NUMBER}\s+(?:of (?:your |the )?)?(?:open |pending )?${ASKED}`,
    'i',
  ),
  // ISS-904 c1 on dev.706 ('A batch holds up to ${QUESTIONNAIRE_MAX_ITEMS} items') and ISS-1262
  // ('up to 15 items, rest next round'): a card's questions counted by the card's own word for
  // them, on a line about asking (a verdict's evidence items are no questions)
  new RegExp(
    String.raw`^(?=.*\b(?:questions?|questionnaires?|rounds?|cards?|batch(?:es)?|ask(?:s|ed|ing)?|rest)\b).*?\b((?:at most|up to|no more than|a maximum of|max(?:imum)?)\s+${NUMBER}\s+items?)\b`,
    'i',
  ),
  // 'a maximum of 3 clarifications', 'limit: 2 rounds', 'two questions at most'
  new RegExp(
    String.raw`\b(?:max(?:imum)?|limit|cap)(?:\s+of)?:?\s+${NUMBER}\s+(?:open\s+|pending\s+)?${ASKED}`,
    'i',
  ),
  new RegExp(
    String.raw`\b${NUMBER}\s+(?:open\s+|pending\s+)?${ASKED}\s+(?:at most|max(?:imum)?|or (?:fewer|less)|tops)\b`,
    'i',
  ),
  // ISS-904 c1 on dev.703: 'Ask one short question at a time' (the widget)
  /\bone\s+(?:short\s+|brief\s+|single\s+)?(?:question|clarification|card|questionnaire card|batch)\b[^.\n]{0,40}\bat a time\b/i,
  // ISS-904 c1 on dev.703: 'ask the person one short question' (the room agent, support.decide)
  /\bask(?:s|ing)?\b[^.\n]{0,30}\bone\s+(?:short|brief|single)\s+(?:question|clarification)\b/i,
  /\bonly\s+(?:one|a single)\s+(?:short\s+|brief\s+)?(?:question|clarification)\b/i,
  /\bone\s+(?:short\s+|brief\s+|single\s+)?(?:question|clarification)\s+(?:per|a|each)\s+(?:turn|reply|message|round|reporter|item|pass|thread)\b/i,
  /\b(?:at most )?one is open (?:at a time|per)\b/i,
  // ISS-904 c1 on dev.701: the clarify tool said 'Refused while one is open on the item'; ISS-1262:
  // the steward's triage prompt said the door 'refuses by name while one of theirs is still open'
  /\b(?:refused|refuses|rejected|waits?)\b[^.\n]{0,30}\b(?:while|when|if|as long as)\s+(?:one(?: of (?:theirs|yours|them))?|a (?:question|clarification|card|questionnaire|batch)|an ask)\s+(?:is|stays|still)\s+(?:already\s+|still\s+)?(?:open|pending|unanswered|waiting)\b/i,
  // ISS-904 c1 on dev.706: 'A card sent while another still waits is refused' (the BA's card tools)
  /\bwhile another\b[^.\n]{0,40}\b(?:is )?refused\b/i,
  /\b(?:STEWARD_ASK_LIMIT|STEWARD_OPEN_ASKS_MAX|FEEDBACK_CLARIFICATION_ALREADY_OPEN|CLARIFICATION_ALREADY_OPEN|ONBOARDING_QUESTIONS_OVER_CAP|ONBOARDING_MAX_QUESTIONS|QUESTIONNAIRE_ROUNDS_EXHAUSTED|QUESTIONNAIRE_MAX_ROUNDS|QUESTIONNAIRE_MAX_ITEMS|QUESTIONNAIRE_ALREADY_OPEN|INTAKE_QUESTIONS_MAX)\b/,
  // the same constants by shape; QUESTION_MAX (one question's characters) and QUESTION_ALREADY_OPEN
  // (the same question asked twice, word for word) are no count
  /\b(?:[A-Z]+_)*(?:QUESTIONS|CLARIFICATIONS|ASKS|ROUNDS)_(?:MAX|LIMIT|CAP)\b|\b(?:MAX|LIMIT|CAP)_(?:[A-Z]+_)*(?:QUESTIONS|CLARIFICATIONS|ASKS|ROUNDS)\b|\b(?:[A-Z]+_)*(?:QUESTIONNAIRES?|CLARIFICATIONS?|ASKS?|CARDS?)_(?:ALREADY_OPEN|OVER_CAP|EXHAUSTED)\b/,
];

/** Each line of `text` that names a count, as `<where>:<line>: "<the phrase>"`. */
function countsIn(where: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    for (const count of COUNTS) {
      const m = count.exec(line);
      if (m) return [`${where}:${i + 1}: "${(m[1] ?? m[0]).trim()}"`];
    }
    return [];
  });
}

const REPO = new URL('../../../../', import.meta.url).pathname;
const SRC = new URL('..', import.meta.url).pathname;
const CONTRACTS = new URL('../../../contracts/src/', import.meta.url).pathname;
const PUBLISHED = new URL('../../contracts/', import.meta.url).pathname;
const WEB_COPY = new URL('../../../web-v2/src/lib/i18n/copy/', import.meta.url).pathname;
const RUNNER_TEXTS = [
  new URL('../../../runner/crates/runner-workspace/assets/forge-master-skill.md', import.meta.url)
    .pathname,
  new URL('../../../runner/crates/forge-runner/src/cmd/question.rs', import.meta.url).pathname,
];

const rel = (path: string) => relative(REPO, path);

function sourcesUnder(dir: string, kind = /\.tsx?$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path, kind);
    return kind.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every source an agent's or a person's ask is written in: core, contracts, runner text, web copy. */
const SOURCES = [
  ...sourcesUnder(SRC),
  ...sourcesUnder(CONTRACTS),
  ...RUNNER_TEXTS,
  ...sourcesUnder(WEB_COPY, /\.json$/),
];

/** The published contracts: the MCP tool list agents read, and the API every route answers by. */
const PUBLISHED_FILES = ['forge-mcp.tools.json', 'forge-api.openapi.json'];
const published = (file: string): unknown =>
  JSON.parse(readFileSync(join(PUBLISHED, file), 'utf8'));

/** An array element's place: its `name` where it has one (a tool), else its index. */
const placeOf = (v: unknown, i: number) =>
  typeof (v as { name?: unknown })?.name === 'string' ? (v as { name: string }).name : String(i);

/** Every `description` and `summary` a published contract carries, with the JSON path it sits at. */
function publishedTexts(node: unknown, at = ''): Array<{ at: string; text: string }> {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => publishedTexts(v, `${at}[${placeOf(v, i)}]`));
  }
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    (key === 'description' || key === 'summary') && typeof value === 'string'
      ? [{ at: `${at}.${key}`, text: value }]
      : publishedTexts(value, `${at}.${key}`),
  );
}

/**
 * A route schema caps the questions it carries when the array a question field holds is chained with
 * `.max(` or `.length(` (ISS-904 c1 on dev.708: a step handoff's `openQuestions` `.max(10)`, a
 * requirement spec's `.max(50)`). A card's `items` and `answers` are its questions only in the
 * card's own sources. A bound on each question's text, or on the list's bytes, is no count.
 */
const QUESTION_FIELDS = /\b(openQuestions|questions|asks|clarifications|unknowns)\??\s*[:=]\s*/g;
const CARD_FIELDS = /\b(items|answers)\??\s*[:=]\s*/g;
const CARD_SOURCES = /(?:contracts\/src\/onboarding\.ts|core\/src\/questionnaires\/)/;
const QUESTION_KEY = /^(?:openQuestions|questions|asks|clarifications|unknowns)$/;

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
      if (!/\.array\(/.test(chain) || !/\)\.(?:max|length)\(/.test(chain)) return [];
      return [`${path}:${text.slice(0, m.index).split('\n').length}: ${m[1]} ${chain}`];
    }),
  );
}

/**
 * The same cap as published, however the source wrote it: a question field's array schema with a
 * `maxItems` (a card's `items` and `answers` on a questionnaire route), in either contract.
 */
function publishedCaps(file: string, node: unknown, at = ''): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => publishedCaps(file, v, `${at}[${placeOf(v, i)}]`));
  }
  if (!node || typeof node !== 'object') return [];
  const own = Object.entries((node as { properties?: object }).properties ?? {}).flatMap(
    ([key, schema]) => {
      const asked =
        QUESTION_KEY.test(key) || (/questionnaire/i.test(at) && /^(?:items|answers)$/.test(key));
      const arrays = [schema, ...((schema as { anyOf?: unknown[] }).anyOf ?? [])] as Array<{
        type?: string;
        maxItems?: number;
      }>;
      const capped = arrays.find((s) => s?.type === 'array' && s.maxItems !== undefined);
      return asked && capped ? [`${file} ${at}.${key}: maxItems ${capped.maxItems}`] : [];
    },
  );
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, value]) => publishedCaps(file, value, `${at}/${key}`)),
  ];
}

const SCHEMA_SOURCES = [...sourcesUnder(SRC), ...sourcesUnder(CONTRACTS)];

describe('no question count returns to what asks a person (ISS-904, ISS-1262)', () => {
  it('reads every source and published text, so a moved file cannot pass by matching nothing', () => {
    expect(SOURCES.length).toBeGreaterThan(2000);
    for (const file of [
      'packages/core/src/steward/prompts.ts',
      'packages/core/src/feedback/rules.ts',
      'packages/core/src/onboarding/prompt.ts',
      'packages/core/src/assistant/prompt/door-widget.ts',
      'packages/core/src/guides/room-agent-guide.ts',
      'packages/core/src/mcp/feedback-tool.ts',
      'packages/core/src/pipeline/step-handoff-schema.ts',
      'packages/contracts/src/support.ts',
      'packages/runner/crates/runner-workspace/assets/forge-master-skill.md',
      'packages/web-v2/src/lib/i18n/copy/widget.json',
    ]) {
      expect(SOURCES.map(rel)).toContain(file);
    }
    expect(publishedTexts(published('forge-mcp.tools.json')).length).toBeGreaterThan(100);
    expect(listGuides().length).toBeGreaterThan(20);
  });

  it('no served guide names a count of questions', () => {
    const found = listGuides().flatMap(({ slug }) =>
      countsIn(`guide ${slug}`, getGuide(slug)?.body ?? ''),
    );
    expect(found).toEqual([]);
  });

  it('no prompt, card, tool, door, refusal or copy source names a count of questions', () => {
    const found = SOURCES.flatMap((path) => countsIn(rel(path), readFileSync(path, 'utf8')));
    expect(found).toEqual([]);
  });

  it('no published tool description or route names a count of questions', () => {
    const found = PUBLISHED_FILES.flatMap((file) =>
      publishedTexts(published(file)).flatMap(({ at, text }) => countsIn(`${file} ${at}`, text)),
    );
    expect(found).toEqual([]);
  });

  it('no route schema caps the questions a field carries, in source or as published', () => {
    expect(SCHEMA_SOURCES).toContain(join(SRC, 'pipeline/step-handoff-schema.ts'));
    expect(SCHEMA_SOURCES).toContain(join(CONTRACTS, 'suggestions.ts'));
    const found = [
      ...SCHEMA_SOURCES.flatMap((path) =>
        cappedQuestionFields(rel(path), readFileSync(path, 'utf8')),
      ),
      ...PUBLISHED_FILES.flatMap((file) => publishedCaps(file, published(file))),
    ];
    expect(found).toEqual([]);
  });
});

/** ISS-1262 criterion 3: each phrasing planted in a file the guard reads goes red naming both. */
describe('a planted count goes red naming its file and phrase (ISS-1262)', () => {
  const PLANTS: ReadonlyArray<[file: string, line: string, phrase: string]> = [
    [
      'packages/core/src/steward/prompts.ts',
      "  'Ask at most 3 questions per item.',",
      'at most 3 questions',
    ],
    [
      'packages/core/src/onboarding/prompt.ts',
      '- Post up to 15 items, rest next round.',
      'up to 15 items',
    ],
    [
      'packages/core/src/assistant/prompt/door-widget.ts',
      '- Ask one short question at a time.',
      'one short question at a time',
    ],
    [
      'packages/core/src/assistant/prompt/door-widget.ts',
      '- Ask one question at a time.',
      'one question at a time',
    ],
    [
      'packages/core/src/guides/room-agent-guide.ts',
      'Gather: ask the person one short question.',
      'ask the person one short question',
    ],
    [
      'packages/contracts/src/support.ts',
      '\t"gather: ask the person one short question",',
      'ask the person one short question',
    ],
    [
      'packages/core/src/mcp/feedback-tool.ts',
      "  'Refused while one is open on the item or to the same reporter.',",
      'Refused while one is open',
    ],
    [
      'packages/core/src/steward/prompts.ts',
      "  'the door refuses by name while one of theirs is still open.',",
      'refuses by name while one of theirs is still open',
    ],
    [
      'packages/runner/crates/runner-workspace/assets/forge-master-skill.md',
      '- Ask the owner at most two questions a pass.',
      'at most two questions',
    ],
    [
      'packages/web-v2/src/lib/i18n/copy/widget.json',
      '    "widget.limit": "A maximum of 3 questions per issue",',
      'maximum of 3 questions',
    ],
  ];

  it.each(PLANTS)('%s: %s', (file, line, phrase) => {
    const path = join(REPO, file);
    expect(SOURCES, `${file} is not a file the guard reads`).toContain(path);
    const text = readFileSync(path, 'utf8');
    const at = text.split('\n').length + 1;
    expect(countsIn(rel(path), `${text}\n${line}`)).toEqual([`${file}:${at}: "${phrase}"`]);
  });

  it('a planted tool description names the published tool and the phrase', () => {
    const tools = published('forge-mcp.tools.json') as {
      tools: Array<{ name: string; description: string }>;
    };
    const tool = tools.tools.find((t) => t.name === 'project_feedback');
    if (!tool) throw new Error('the tool list no longer holds project_feedback');
    tool.description += '\nRefused while one is open on the item.';
    const found = publishedTexts(tools).flatMap(({ at, text }) =>
      countsIn(`forge-mcp.tools.json ${at}`, text),
    );
    expect(found).toEqual([
      expect.stringMatching(
        /^forge-mcp\.tools\.json \.tools\[project_feedback\]\.description:\d+: "Refused while one is open"$/,
      ),
    ]);
  });

  it('a capped question field, in source or as published, names its file and field', () => {
    for (const [file, from, to] of [
      [
        'packages/core/src/pipeline/step-handoff-schema.ts',
        'openQuestions: openList,',
        'openQuestions: z.array(z.string()).max(10),',
      ],
      [
        'packages/contracts/src/suggestions.ts',
        '.array(requirementOpenQuestionSchema)\n',
        '.array(requirementOpenQuestionSchema)\n\t\t.max(50)\n',
      ],
      [
        'packages/contracts/src/onboarding.ts',
        '.array(questionnaireItemSchema)\n\t\t.min(1)',
        '.array(questionnaireItemSchema)\n\t\t.min(1)\n\t\t.max(15)',
      ],
    ] as const) {
      const path = join(REPO, file);
      expect(SCHEMA_SOURCES).toContain(path);
      const text = readFileSync(path, 'utf8');
      expect(text, `${file} no longer holds ${from}`).toContain(from);
      expect(cappedQuestionFields(file, text)).toEqual([]);
      const found = cappedQuestionFields(file, text.replace(from, to));
      expect(found, file).toHaveLength(1);
      expect(found[0]).toMatch(new RegExp(`^${file}:\\d+: (?:openQuestions|items) `));
    }
    const api = published('forge-api.openapi.json') as Record<string, unknown>;
    const json = JSON.stringify(api).replace(/("openQuestions":\{)/, '$1"maxItems":10,');
    const found = publishedCaps('forge-api.openapi.json', JSON.parse(json));
    expect(found).toEqual([
      expect.stringMatching(/^forge-api\.openapi\.json .*\.openQuestions: maxItems 10$/),
    ]);
  });
});

describe('the phrasings a count was written in (ISS-904, ISS-1262)', () => {
  const caught = (line: string) => countsIn('x', line);

  it('catches each', () => {
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
      'Post up to 15 items, rest next round',
      'A card sent while another still waits is refused: ask the rest in the next round.',
      'refused QUESTIONNAIRE_ALREADY_OPEN',
      'Ask one short question at a time',
      'ask the person one short question',
      'Refused while one is open on the item or to the same reporter',
      'the door refuses by name while one of theirs is still open',
      'a maximum of 3 clarifications',
      'two questions at most',
      'ask only one question',
      'one question per turn',
      'const REQUIREMENT_ASKS_MAX = 5;',
      'refused CARD_ALREADY_OPEN',
    ]) {
      expect(caught(planted), planted).toHaveLength(1);
    }
  });

  it('leaves a bound on bytes or characters, and one question per call, alone', () => {
    for (const left of [
      'each with a recommended answer; options are 2-4 of {"id", "label"}',
      '(at least one item; 1048576 bytes of JSON at most)',
      'clarify {feedback, prompt}: ask the reporter one question; `needed` says what would settle it',
      'export const HANDOFF_QUESTIONS_MAX_BYTES = 64 * 1024;',
      'const QUESTION_MAX = 2000;',
      "'QUESTION_ALREADY_OPEN', 'question 9f1c asks this, word for word'",
      'A new revision on the head: refused while another is open',
      'export const AGENT_SESSION_LIVE_MAX_ITEMS = 200;',
    ]) {
      expect(caught(left), left).toEqual([]);
    }
  });

  it('catches each shape a capped question field was written in', () => {
    for (const planted of [
      'openQuestions: z.array(z.string().min(1)).max(10),',
      '\topenQuestions: z.array(requirementOpenQuestionSchema).max(50).optional(),',
      'questions: z\n  .array(questionSchema)\n  .min(1)\n  .max(QUESTIONS_MAX),',
      'const unknowns = z.array(z.string()).max(5);',
      'asks: z.array(askSchema).length(1),',
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
