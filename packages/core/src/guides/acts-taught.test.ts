// @direct-test-of packages/core/src/guides/
// The issue-flow method is what a run reads at the moment it parks, asks or marks. Each act that
// says what it waits on or carries is named there with the refusals that hold it, and every refusal
// the method names is one core can return: a misspelt code teaches a refusal no reader will meet.

import { MERGE_REFUSAL_CODES } from '@forge/contracts/issues';
import { QUESTION_REFUSAL_CODES } from '@forge/contracts/questions';
import { RELEASE_CLIP_MAX_BYTES, RELEASE_CLIP_MAX_SECONDS } from '@forge/contracts/release-page';
import { DESIGN_REFUSAL_CODES } from '@forge/contracts/workflows';
import { describe, expect, it } from 'vitest';
import { memorySources, memoryWritableSources } from '../db/schema-vocabulary.js';
import { getGuide } from './registry.js';

const CODES = new Set<string>([...QUESTION_REFUSAL_CODES, ...MERGE_REFUSAL_CODES]);
const named = (body: string) => [
  ...new Set([...body.matchAll(/\b(?:QUESTION|ARTIFACT_CARRIER)_[A-Z_]+\b/g)].map((m) => m[0])),
];
// a key quoted on its own is the bare string the ask route refuses, unless the sentence says so
const bareRequirementKeys = (text: string) =>
  text.split("'REQ-n'").length -
  text.split("{ requirement: 'REQ-n' }").length -
  (text.split("bare `'REQ-n'`").length - 1);
const body = (slug: string) => getGuide(slug)?.body ?? '';

describe('the issue-flow method teaches the acts that name what they wait on', () => {
  const flow = body('issue-flow');

  it.each([
    [
      'a business question names its requirement',
      [
        '`POST /api/questions`',
        '`about`',
        '{ requirement: null }',
        "{ contract: '<project>/<contract>' }",
        "{ requirement: 'REQ-n' }",
        'QUESTION_ABOUT_UNKNOWN',
        'QUESTION_ABOUT_NO_REQUIREMENT',
        'QUESTION_ABOUT_SHAPE',
      ],
    ],
    [
      'a park on another landing waits on its merge mark',
      [
        '`awaitsMerge: { issueId }`',
        'QUESTION_MERGE_ALREADY_MARKED',
        'QUESTION_ABOUT_ON_MERGE_WAIT',
      ],
    ],
    [
      "a memory names another project's key by its slug, and is never bookkeeping",
      ['`<its slug> ISS-n`', 'never written as a `decision`'],
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
        '`carriedBy',
        'ARTIFACT_CARRIER_UNKNOWN',
        'ARTIFACT_CARRIER_SELF',
        'ARTIFACT_CARRIER_SHIPPED',
        'ARTIFACT_CARRIER_DESIGN',
      ],
    ],
    [
      'a run records each check it made with its kind and duration, once',
      ['POST /api/issues/:id/checks', 'durationMs', '`probes`', '`review`', 'CHECK_RUN_CONFLICT'],
    ],
  ] as const)('%s', (_act, words) => {
    for (const word of words) expect(flow, `issue-flow no longer names ${word}`).toContain(word);
  });

  it('a memory hit says why it was flagged, and bookkeeping is read only when asked for', () => {
    expect(flow.replace(/\s+/g, ' ')).toContain(
      'A hit carrying `staleReason` was flagged possibly stale by a release for the reason it gives, so check that claim before relying on it; a `bookkeeping` row is the upkeep record core keeps of memory itself, never written by a run, and returned only when `sourceFilter` names it.',
    );
    expect(memorySources).toContain('bookkeeping');
    expect(memoryWritableSources).not.toContain('bookkeeping');
  });

  it.each(['issue-flow', 'pipeline-and-issue-lifecycle'])(
    '%s names only refusals core returns',
    (slug) => {
      expect(named(body(slug)).filter((code) => !CODES.has(code))).toEqual([]);
    },
  );

  it('offers a requirement key as `about` only under `requirement`', () => {
    expect(bareRequirementKeys(flow)).toBe(0);
    expect(bareRequirementKeys("`{ requirement: null }`, or `'REQ-n'`")).toBe(1);
  });

  it('catches a refusal no code list holds', () => {
    expect(named('refused `QUESTION_MERGE_ALREADY_MARKD`').filter((c) => !CODES.has(c))).toEqual([
      'QUESTION_MERGE_ALREADY_MARKD',
    ]);
  });
});

describe('the workflow-design guide clears pin-only dependents in one act', () => {
  const design = body('workflow-design');

  it('tells a writer a pin-only proposal approves by itself, and names the act for the dependents nobody proposed', () => {
    for (const word of [
      'one whose only change is the pin approves by itself',
      'WORKFLOW_DESIGN_UNCOMPARABLE',
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
  const flow = body('issue-flow');
  const verdicts = flow.slice(flow.indexOf('### 5.'), flow.indexOf('### 6.'));

  it('asks for the clip in the verdict section, cited in the verdict evidence', () => {
    expect(verdicts).toMatch(/records a short screen clip of each observable criterion it judges/);
    expect(verdicts).toMatch(/cite its name in that verdict's `evidence`/);
  });

  it('states the ceiling a release page shows, read from the contract', () => {
    expect(verdicts).toContain(
      `at most ${RELEASE_CLIP_MAX_SECONDS} seconds and ${RELEASE_CLIP_MAX_BYTES / (1024 * 1024)} MiB`,
    );
  });
});
