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
        "another project's work is a contract wait on its version",
        '`POST /api/issues/:id/contract-waits`',
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
        '`--probes <issue id>=<file>`',
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
      "Another project's work is a contract wait on its version, `POST /api/issues/:id/contract-waits { contract, minVersion, reason?, dueAt? }`, never an edge to its issue",
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
  });

  it("takes the clip from the criterion's span on a box, never a recorder run by hand (ISS-1320)", () => {
    expect(verdicts).toMatch(/A criterion's span on a box records it and attaches it/);
    expect(verdicts).not.toMatch(/web-v2 clip|pnpm clip/);
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
      expect(codes.sort()).toEqual([
        'VERDICT_RELEASE_VISUAL_FOREIGN',
        'VERDICT_RELEASE_VISUAL_SHAPE',
      ]);
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

describe('the mockups guide teaches delivering a mockup to the person who asked (ISS-1319)', () => {
  // adminhub-api's L-39: a blurry Paycheck mockup, an image sent where a PDF was asked for, and a
  // long PDF process the person never asked for: nothing taught how a mockup reaches a person
  const prose = (slug: string) => body(slug).split(/\s+/).join(' ');

  it('renders it sharp, in the format named, by the shortest route, with no process unasked', () => {
    const all = prose('mockups');
    const from = all.indexOf('### Delivering one');
    expect(from, 'the mockups guide has no Delivering one section').toBeGreaterThan(-1);
    const text = all.slice(from, all.indexOf('###', from + 3));
    expect(text).toContain('2x device scale, or the source size');
    expect(text).toContain('the whole frame');
    expect(text).toMatch(/format they named: a PDF, an image or the MK-n link/);
    expect(text).toContain('shortest route');
    expect(text).toContain('no step, review or document they did not ask for');
  });

  it('points the product role at those lines where it sends a mockup to a person', () => {
    expect(prose('product-role')).toContain('Sending a mockup to a person');
    expect(prose('product-role')).toContain('`mockups` guide, *Delivering one*');
  });
});

describe('an outside call proven only against a mock is not ready for the approval ask (ISS-1329)', () => {
  // adminhub-api 0.28.0: a master asked for production approval of a PGPrints integration whose send
  // had run only against a mock, planning the first real order "after it goes live"; then a room told
  // a person to enter a key into a staging supplier that did not exist yet (FB-739)
  const prose = (slug: string) => body(slug).split(/\s+/).join(' ');

  it.each(['forge-master', 'room-agent'])(
    '%s asks for the test account first, and names the smallest real test where none exists',
    (slug) => {
      const text = prose(slug);
      expect(text).toContain('proven only against a simulation is not ready for the approval ask');
      expect(text).toContain("the provider's test or sandbox account on staging");
      expect(text).toContain('send, cancel and tracking');
      expect(text).toContain('the smallest real test before deploy, never "after it goes live"');
    },
  );

  it.each(['forge-master', 'room-agent'])(
    "%s reads an environment's state before giving a person setup steps on it",
    (slug) => {
      const text = prose(slug);
      expect(text).toContain("read that environment's state");
      expect(text).toContain('name any missing first step');
      expect(text).toContain('ask only for what only the person holds');
    },
  );

  it.each(['issue-flow', 'qa'])('%s has a judge say how an outside call was proven', (slug) => {
    const text = prose(slug);
    expect(text).toContain('`integrationProof: "live"`');
    expect(text).toContain('`"simulated"`');
    expect(text).toMatch(/release page line reads (it|Live or Simulated)/);
  });
});

describe('a room agent states a live setting from a read of its own turn, and names who acts (ISS-1354)', () => {
  // FB-763 (adminhub-api L-46): after ISS-1329 taught reading first, three replies still failed audit:
  // an account stated from an earlier turn's read, a field from the release seeder, and "em" for the
  // member's own act. The lines are where the agent reads as it writes: the guide's Answering section
  // and support.reply's card, served beneath it.
  const prose = body('room-agent').split(/\s+/).join(' ');
  const answering = prose.slice(
    prose.indexOf('### Answering'),
    prose.indexOf('### A secret you need'),
  );

  it('the Answering section holds a live setting to a read of this turn, or says from when', () => {
    expect(answering).toContain(
      "A live setting, account, field, or an issue's or release's status is stated from a read made in this turn",
    );
    expect(answering).toContain(
      "never from a release plan, release note, a master's earlier post or a read already in your context",
    );
    // ISS-1430: "what a master said" contradicted the master's answer note: his answer of this turn is his check
    expect(answering).toContain(
      "or as the master's check, with when he made it, where he answered your ask in this turn",
    );
  });

  it("the Answering section holds an issue's or release's status to a read, and closed to a deployed release (ISS-1389)", () => {
    expect(answering).toContain(
      "an issue's or release's status is stated from a read made in this turn",
    );
    expect(answering).toContain('An issue is said to be closed only once its release has deployed');
  });

  it('the Answering section names who does each step, never "em" for another person\'s act, and the asker as who they are', () => {
    expect(answering).toContain('Each step names who does it, by role or name');
    expect(answering).toContain('never "em" for another person\'s act');
    expect(answering).toContain('the asker is addressed as the person they are');
  });

  it("support.reply's card, served beneath the guide, carries the same line", () => {
    expect(prose).toContain(
      'A live setting, served version, behaviour (“it works”) or issue or release status is stated from a read of it this turn, or as the master’s check, or said plainly not confirmed now. An issue is closed only once its release has deployed. Each step names who does it, never “em”',
    );
  });

  // ISS-1430 (FB-831, L-167): "say when the earlier read was made" let a dated earlier read be stated,
  // which the reply audit fails; the guide, the reply card and the audit card now say one thing
  it('offers no dated earlier read: read again, or say plainly it is not checked now', () => {
    expect(answering).not.toContain('say when the earlier read was made');
    expect(answering).toContain(
      'Where you cannot read it again, say plainly that you have not checked it now, and never restate the earlier value, dated or not.',
    );
    expect(prose).toContain(
      'A live state (setting, served version, behaviour, record status) stated with no read of that thing this turn fails accurate, dated or not; said as the master’s check, or “not confirmed now”, it does not.',
    );
  });

  // ISS-1416 (FB-824): "not enabled yet" and "still off" (in Vietnamese) were stated from reads a turn old, which the line's
  // "or said to be from an earlier read and when" let stand; and a raise was told landed in AdminHub
  // API's thread when it had been refused there
  it('the Answering section has an earlier turn’s read made again before a setting is said on or off', () => {
    expect(answering).not.toContain('or said to be from an earlier read and when');
    expect(answering).toContain(
      "A turn opens naming when you last read; a read from before it is an earlier turn's, so read again before you say a setting is on or off.",
    );
  });

  it('the guide and the technical card have an act told from its result, refused or where it landed', () => {
    expect(prose).toContain(
      'An act you took is told from its result: a refused raise was not raised, and a raise that landed is named where its result says it landed.',
    );
    expect(prose).toContain('tell that thread the answer, or where its result says it landed');
  });
});

describe('a room agent says what a screen shows only from a look at it (ISS-1356)', () => {
  // owner 2026-11-19: "it does not check the UI and reports nonsense: the feature plainly isn't on the
  // UI, and it confirms it". A PGPrints user was told a menu item appears, did not see it, and was then
  // sent a guide step typing ?tab=2 into the address bar; owner messages waited hours unanswered.
  const prose = body('room-agent').split(/\s+/).join(' ');
  const answering = prose.slice(
    prose.indexOf('### Answering'),
    prose.indexOf('### A secret you need'),
  );

  it('the Answering section makes a screen claim from a look, or says the screen was not seen yet', () => {
    expect(answering).toContain('What a screen shows is said from a look, or not said.');
    expect(answering).toContain('look at it with support.look on that environment');
    expect(answering).toContain("a master's post, a release note or an earlier turn is no look");
    expect(answering).toContain(
      'say in plain words that you have not seen the screen yet and what you are doing about it, never the thing anyway',
    );
  });

  it('a step is walked in a box before it is said, and a workaround step goes to the master as a UI defect', () => {
    expect(answering).toContain('Walk each step in a box yourself before you say it');
    expect(answering).toContain('an address edit, a hidden tab, a field the screen hides');
    expect(answering).toContain('goes to that master as a UI defect with support.record');
    expect(answering).toContain('the person is told the honest next step');
  });

  it('every owner message is answered or told when, within 30 minutes, and a re-ask is counted', () => {
    expect(answering).toContain(
      'Every message the owner writes in a thread gets its answer, or a line saying you are on it and when you will report, within 30 minutes',
    );
    expect(answering).toContain("one left longer shows on the room's daily line");
    expect(answering).toContain('a question asked again is counted against your turn');
  });

  // ISS-1385: the card said "Results only: no acknowledgement", against the guide's line above
  it("support.reply's card teaches the same rule as the guide's Answering section", () => {
    expect(prose).toContain(
      'An owner’s message gets the answer, or one “on it, will report at …” line within 30 minutes; no other acknowledgement, plan or progress',
    );
    expect(prose).not.toContain('Results only: no acknowledgement');
    expect(answering).toContain(
      'or a line saying you are on it and when you will report, within 30 minutes',
    );
  });

  it("serves support.look's card beneath the guide, and support.reply's card carries the line", () => {
    expect(prose).toContain('### `support.look`');
    expect(prose).toContain(
      'look first with support.look { thread, environment, path }, and say only what the look showed',
    );
    expect(prose).toContain(
      'What a screen shows (a button, menu item, field, page) is said only from a look this turn with support.look',
    );
  });
});

// ISS-1399 (FB-807): the row taught close-then-record, and the record refused the closed issue
describe('the lifecycle guide teaches a fix made by hand to record its release before any close', () => {
  it('names the release record, which closes it, before a close by hand', () => {
    const row =
      body('pipeline-and-issue-lifecycle')
        .split('\n')
        .find((r) => r.startsWith('| Finished the work entirely by hand')) ?? '';
    expect(row).toContain('`awaiting_release`, then its release record, which closes it');
    expect(row).toContain('`closed` by hand only where no record closes it');
    expect(row).toContain('`CLAIM_CONFLICT`');
    expect(row).not.toContain('then `closed` once its criteria are met in scope');
  });
});
