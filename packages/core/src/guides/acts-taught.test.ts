// The issue-flow method is what a run reads at the moment it parks, asks or marks. Each act that
// says what it waits on or carries is named there with the refusals that hold it, and every refusal
// the method names is one core can return: a misspelt code teaches a refusal no reader will meet.

import { MERGE_REFUSAL_CODES } from '@forge/contracts/issues';
import { QUESTION_REFUSAL_CODES } from '@forge/contracts/questions';
import { DESIGN_REFUSAL_CODES } from '@forge/contracts/workflows';
import { describe, expect, it } from 'vitest';
import { memorySources, memoryWritableSources } from '../db/schema-vocabulary.js';
import { getGuide } from './registry.js';

const CODES = new Set<string>([...QUESTION_REFUSAL_CODES, ...MERGE_REFUSAL_CODES]);
const named = (body: string) => [
  ...new Set([...body.matchAll(/\b(?:QUESTION|ARTIFACT_CARRIER)_[A-Z_]+\b/g)].map((m) => m[0])),
];
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
        'QUESTION_ABOUT_UNKNOWN',
        'QUESTION_ABOUT_NO_REQUIREMENT',
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
      'a landing names what another issue carries',
      [
        '`carriedBy',
        'ARTIFACT_CARRIER_UNKNOWN',
        'ARTIFACT_CARRIER_SELF',
        'ARTIFACT_CARRIER_SHIPPED',
        'ARTIFACT_CARRIER_DESIGN',
      ],
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

  it('catches a refusal no code list holds', () => {
    expect(named('refused `QUESTION_MERGE_ALREADY_MARKD`').filter((c) => !CODES.has(c))).toEqual([
      'QUESTION_MERGE_ALREADY_MARKD',
    ]);
  });
});

describe('the workflow-design guide clears pin-only dependents in one act', () => {
  const design = body('workflow-design');

  it('tells a writer not to propose a pin-only dependent again, and names the act', () => {
    for (const word of [
      'one whose only change would be the pin is never proposed again',
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
