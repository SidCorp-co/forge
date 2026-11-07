import { describe, expect, it } from 'vitest';
import {
  criteriaListOf,
  DESCRIPTION_CRITERIA_RULE,
  unrecordedCriteriaWarning,
} from './description-criteria.js';

// epod ISS-97 and forge ISS-1070..1073, as filed: the criteria under a bold Outcome label
const EPOD_SHAPE = `Owner, 2026-11-07: the screen shows too much.

**Outcome:**
- One attention request per route.
- No full \`/releases\` fetch outside Releases.
- The issue page makes fewer than 40 calls.`;

describe('criteria-list-in-description: a heading naming criteria over a list', () => {
  it.each([
    ['a bold label with its colon inside', EPOD_SHAPE, 'Outcome', 3],
    [
      'a markdown heading',
      '## Acceptance criteria\n\n1. the list loads\n2. a clerk signs in',
      'Acceptance criteria',
      2,
    ],
    ['a label alone ending in a colon', 'Criteria:\n- [ ] the page answers 200', 'Criteria', 1],
    ['a bold label with its colon outside', '**Done when**:\n* the cut is green', 'Done when', 1],
    [
      "the writing guide's own block",
      '### What to do\n- the board shows the gate\n- the gate names its owner',
      'What to do',
      2,
    ],
    [
      'a loose list with continuation lines',
      '**Outcome**\n\n- one\n  still one\n\n- two',
      'Outcome',
      2,
    ],
  ])('reads %s', (_, text, heading, count) => {
    const list = criteriaListOf(text);
    expect(list?.heading).toBe(heading);
    expect(list?.items).toHaveLength(count);
  });

  it('reads the items in order, without their markers or boxes', () => {
    expect(criteriaListOf('Criteria:\n- [x] first\n2) second')?.items).toEqual(['first', 'second']);
  });

  it.each([
    ['no description', null],
    ['prose with no heading', 'The page is slow.\n- a stray bullet'],
    [
      'a heading over prose, as ISS-1079 wrote its Outcome',
      'Outcome: a release that completes records the commit.',
    ],
    ['another heading over a list', '**Screens:**\n- Integrations\n- Modules'],
    [
      'a heading whose list a paragraph interrupts',
      '**Outcome:**\nWe want this.\n- a list after it',
    ],
    ['an Outcome word inside a sentence', 'The outcome: is not a heading here\n- item'],
  ])('reads none in %s', (_, text) => {
    expect(criteriaListOf(text)).toBeNull();
  });
});

describe('the warning a filing or a lease-take is told', () => {
  const id = '35bf6316-f7ec-4ebf-812f-6d985266ab3a';

  it('names the rule, the heading, the count and the door that records them', () => {
    const told = unrecordedCriteriaWarning({ id, description: EPOD_SHAPE, liveCriteria: 0 });
    expect(told).toContain(DESCRIPTION_CRITERIA_RULE);
    expect(told).toContain('3 items under "Outcome"');
    expect(told).toContain('0 criteria on the record');
    expect(told).toContain(`PUT /api/issues/${id}/criteria`);
    expect(told).toContain('`acceptanceCriteria`');
  });

  it('says nothing where the issue has criteria on the record', () => {
    expect(unrecordedCriteriaWarning({ id, description: EPOD_SHAPE, liveCriteria: 1 })).toBeNull();
  });

  it('says nothing where the description lists no criteria', () => {
    expect(
      unrecordedCriteriaWarning({ id, description: 'a slow page', liveCriteria: 0 }),
    ).toBeNull();
  });
});
