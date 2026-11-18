// @direct-test-of packages/core/src/guides/
// @direct-test-of packages/core/src/questions/cards.ts
// @direct-test-of packages/core/src/prompt/facts/affordance-cards.ts
// The issue-flow method is what a run reads at the moment it parks, asks or marks. Each act that
// says what it waits on or carries is named there, as served with the cards of the doors it acts
// through (ISS-1251), with the refusals that hold it, and every refusal the method names is one core
// can return: a misspelt code teaches a refusal no reader will meet.

import { MERGE_REFUSAL_CODES, VERDICT_REFUSAL_CODES } from '@forge/contracts/issues';
import { QUESTION_REFUSAL_CODES } from '@forge/contracts/questions';
import { RELEASE_CLIP_MAX_BYTES, RELEASE_CLIP_MAX_SECONDS } from '@forge/contracts/release-page';
import { DESIGN_REFUSAL_CODES } from '@forge/contracts/workflows';
import { beforeAll, describe, expect, it } from 'vitest';
import { memorySources } from '../db/schema-vocabulary.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { getGuide } from './registry.js';
import { servedGuideBody } from './served.js';

const CODES = new Set<string>([...QUESTION_REFUSAL_CODES, ...MERGE_REFUSAL_CODES]);
const named = (body: string) => [
  ...new Set([...body.matchAll(/\b(?:QUESTION|ARTIFACT_CARRIER)_[A-Z_]+\b/g)].map((m) => m[0])),
];
// a key quoted on its own is the bare string the ask route refuses, unless the sentence says so
const bareRequirementKeys = (text: string) =>
  text.split('"REQ-n"').length - text.split('{"requirement":"REQ-n"}').length;
// at load: a describe reads its guide served while the suite is collected
provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });
const body = (slug: string) => {
  const guide = getGuide(slug);
  return guide ? servedGuideBody(guide) : '';
};

describe('the issue-flow method teaches the acts that name what they wait on', () => {
  let flow = '';
  beforeAll(() => {
    flow = body('issue-flow');
  });

  it.each([
    [
      'a business question names its requirement',
      [
        '`POST /api/questions`',
        '`about`',
        '{"requirement":null}',
        '{"contract":"<project>/<contract>"}',
        '{"requirement":"REQ-n"}',
        'QUESTION_ABOUT_UNKNOWN',
        'QUESTION_ABOUT_NO_REQUIREMENT',
        'QUESTION_ABOUT_SHAPE',
      ],
    ],
    [
      'a park asked in words names what it is about itself (ISS-583)',
      ['park once with `needs` and the same `about`', 'QUESTION_ABOUT_ON_DESIGN_WAIT'],
    ],
    [
      'a park on its own landing waits on its merge mark',
      [
        '`"awaitsMerge":{"issueId":"<id>"}`',
        'QUESTION_MERGE_ALREADY_MARKED',
        'QUESTION_ABOUT_ON_MERGE_WAIT',
      ],
    ],
    [
      'ordering between issues is a blocks edge, never a park (ISS-738)',
      [
        "Waiting on another issue's landing is not a park but a `blocks` edge",
        '`issues/<dependent>/dependencies -X POST`',
        'a park is only for an act a person owes',
        'QUESTION_MERGE_IS_ORDERING',
      ],
    ],
    [
      "a memory names another project's key by its slug, answers its curation, and is never a log",
      [
        '`<its slug> ISS-n`',
        'never written as a `decision`',
        '`recheckWhen`',
        '`updates`',
        '`landedOn`',
      ],
    ],
    [
      'the fast lane is taken only for the approved change, and deploys web alone (REQ-39 BC-7)',
      [
        '`GET /api/issues/:id/lane`',
        '`pnpm merge-check --lane fast`',
        '`patchId`',
        'FAST_LANE_CHANGED_SINCE_APPROVAL',
        'FAST_LANE_NOT_ELIGIBLE',
        '`{ issueId, targets }`',
        'FAST_LANE_UNVERIFIED',
      ],
    ],
    [
      'a landing names what another issue carries',
      [
        '`"carriedBy":"<that issue\'s key>"`',
        'ARTIFACT_CARRIER_UNKNOWN',
        'ARTIFACT_CARRIER_SELF',
        'ARTIFACT_CARRIER_SHIPPED',
        'ARTIFACT_CARRIER_DESIGN',
      ],
    ],
    [
      "a merge check runs the issue's kept probes and is refused by name without them (REQ-36 BC-9)",
      [
        '`pnpm merge-check --probes <file>`',
        '`GET /api/issues/:id/criteria`',
        'MERGE_PROBE_MISSING',
        'MERGE_PROBE_RED',
      ],
    ],
    [
      'a probe expects lists of strings, never one string',
      ['`bodyIncludes` and `stdoutIncludes` are lists of strings', '`["held"]`, never `"held"`'],
    ],
    [
      'a run records each check it made with its kind and duration, once',
      ['POST /api/issues/:id/checks', 'durationMs', '`probes`', '`review`', 'CHECK_RUN_CONFLICT'],
    ],
  ] as const)('%s', (_act, words) => {
    for (const word of words) expect(flow, `issue-flow no longer names ${word}`).toContain(word);
  });

  it('a memory hit says why it was flagged and what it is, and a copy is history read only by name (ISS-1121)', () => {
    expect(flow.replace(/\s+/g, ' ')).toContain(
      "A hit carrying `staleReason` was flagged for a re-check, by a release or by a landing touching what it names, for the reason it gives, so check that claim before relying on it; a hit's `curation` says its type, and a `hypothesis` is a lead, never a fact. Recall reads curated memory; an issue, comment or job copy is history, returned only when `sourceFilter` names it.",
    );
    expect(memorySources).not.toContain('bookkeeping');
  });

  it('the lifecycle guide points ordering at a blocks edge, and lets a park name only its own mark (ISS-738)', () => {
    const lifecycle = body('pipeline-and-issue-lifecycle');
    for (const word of [
      '**Waiting on another issue is not `needs_info`.**',
      'it is only for an act a person owes',
      'add a `blocks` edge (`issues/<dependent>/dependencies -X POST`)',
      '`"awaitsMerge":{"issueId":"<id>"}`, naming this issue',
      "a park naming another issue's mark is refused `QUESTION_MERGE_IS_ORDERING`",
    ]) {
      expect(lifecycle, `the lifecycle guide no longer names ${word}`).toContain(word);
    }
    for (const guide of [flow, lifecycle]) {
      expect(guide).not.toContain('this one or another of its project');
      expect(guide).not.toContain("Waiting on another issue's landing is `awaitsMerge");
    }
  });

  it.each(['issue-flow', 'pipeline-and-issue-lifecycle'])(
    '%s names only refusals core returns',
    (slug) => {
      expect(named(body(slug)).filter((code) => !CODES.has(code))).toEqual([]);
    },
  );

  it('offers a requirement key as `about` only under `requirement`', () => {
    expect(bareRequirementKeys(flow)).toBe(0);
    expect(bareRequirementKeys('`{"requirement":null}`, or `"REQ-n"`')).toBe(1);
  });

  it('catches a refusal no code list holds', () => {
    expect(named('refused `QUESTION_MERGE_ALREADY_MARKD`').filter((c) => !CODES.has(c))).toEqual([
      'QUESTION_MERGE_ALREADY_MARKD',
    ]);
  });
});

describe('the workflow-design guide clears pin-only dependents in one act', () => {
  const design = body('workflow-design');

  it('tells a writer a pin-only proposal waits on its approver, and names the one act that clears the dependents', () => {
    expect(design).not.toContain('approves by itself');
    for (const word of [
      'Nothing approves itself, a pin-only revision included',
      '`GET …/workflows/<base>/design/repins`',
      '`POST …/design/repins',
      'WORKFLOW_REPIN_PENDING_CHANGE',
    ]) {
      expect(design, `workflow-design no longer names ${word}`).toContain(word);
    }
  });

  it('names only repin refusals core returns', () => {
    const repins = [...design.matchAll(/\bWORKFLOW_REPIN_[A-Z_]+\b/g)].map((m) => m[0]);
    expect(repins.length).toBeGreaterThan(0);
    expect(repins.filter((c) => !(DESIGN_REFUSAL_CODES as readonly string[]).includes(c))).toEqual(
      [],
    );
  });
});

describe('a judge records a clip of each observable criterion it judges (REQ-40 BC-4)', () => {
  // J7 on 0.4.0-dev.223: none of 30 observable QA verdicts carried a clip, and nothing in the
  // method a judge reads asked for one
  const flow = getGuide('issue-flow')?.body ?? '';
  const verdicts = flow.slice(flow.indexOf('### 5.'), flow.indexOf('### 6.'));

  it('asks for the clip in the verdict section, cited in the verdict evidence', () => {
    expect(verdicts).toMatch(/records a short screen clip of each observable criterion it judges/);
    expect(verdicts).toMatch(/cite both names in that verdict's\s+`evidence`/);
  });

  it('asks why a judgement keeps no clip in withoutClip, never in the reason it gives', () => {
    expect(verdicts).toMatch(/without a clip says why in `withoutClip`/);
    expect(verdicts).toMatch(/never in\s+`reason`/);
    expect(verdicts).toContain('pnpm --filter web-v2 clip');
  });

  it('states the ceiling a release page shows, read from the contract', () => {
    expect(verdicts).toContain(
      `at most ${RELEASE_CLIP_MAX_SECONDS} seconds and ${RELEASE_CLIP_MAX_BYTES / (1024 * 1024)} MiB`,
    );
  });
});

describe('a judge marks the release visual and a master posts the card (ISS-1308)', () => {
  // the last six releases of every project on dev showed no picture although judges had attached
  // clips and shots: nothing a judge read asked which of them shows a line, and no master posted one
  const prose = (slug: string) => body(slug).split(/\s+/).join(' ');

  it.each(['issue-flow', 'qa'])(
    '%s teaches the mark, its owed line and its refusals as core returns them',
    (slug) => {
      const text = prose(slug);
      expect(text).toContain('`releaseVisual: { desktop, phone, still, seconds }`');
      expect(text).toContain('"visual owed"');
      expect(text).toContain('`withoutClip`');
      const codes = [...new Set(text.match(/VERDICT_RELEASE_VISUAL_[A-Z_]+/g) ?? [])];
      expect(codes.sort()).toEqual(['VERDICT_RELEASE_VISUAL_FOREIGN', 'VERDICT_RELEASE_VISUAL_SHAPE']);
      for (const code of codes) expect(VERDICT_REFUSAL_CODES).toContain(code);
    },
  );

  it.each(['forge-master', 'dispatch'])(
    "%s teaches posting the release page's card with its attachments, in the owner's language",
    (slug) => {
      const text = prose(slug);
      expect(text).toMatch(/release post(?: is a card|\.\*\* Post a release as a card)/i);
      expect(text).toContain('`card`');
      expect(text).toMatch(/attachments(: card\.attachments)?/);
      expect(text).toContain("owner's language");
    },
  );
});

describe('the trace route is taught where a trace is written (FB-209)', () => {
  // a master asked to trace a BC read both guides, found no route, and read core's source to learn
  // that the route appends a criterion and takes only its own requirement's BCs
  const prose = (slug: string) => body(slug).split(/\s+/).join(' ');

  it.each(['issue-flow', 'requirement-lifecycle'])(
    '%s names the route, its body, that it adds criteria, and its own-requirement rule',
    (slug) => {
      const text = prose(slug);
      expect(text).toContain('`POST /api/issues/:id/criteria/traces {');
      expect(text).toMatch(/criteria\/traces \{ codes[^`]*\}` ADDS (one|a) criterion per code/);
      expect(text).toContain("takes only BCs of the issue's own requirement");
      expect(text).toContain("a criterion proves a BC of its own issue's requirement");
    },
  );

  // ISS-1283 (FB-711, epod ISS-187): an agent with proven lines sent their codes and got copies
  it.each(['issue-flow', 'requirement-lifecycle'])(
    '%s teaches tying an existing line first, and adding by code second',
    (slug) => {
      const text = prose(slug);
      const tie = text.indexOf('criteria/traces { ties: [{ n, code');
      const add = text.indexOf('criteria/traces { codes');
      expect(tie).toBeGreaterThan(-1);
      expect(add).toBeGreaterThan(tie);
      expect(text).toMatch(/TIES (the issue's existing )?line n to/);
      expect(text).toMatch(/keep(s the criterion's id and|ing its) verdicts/);
    },
  );

  it('names the refusal that sends an add of a line already worded to the tie', () => {
    expect(prose('issue-flow')).toContain(
      'refused `CRITERIA_TRACE_WORDED`, naming that line to tie',
    );
  });
});
