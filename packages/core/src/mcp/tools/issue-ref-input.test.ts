/**
 * ISS-1179 — the sentence and the schema are one registry, and the one that is not an issue
 * reference is refused by name.
 *
 * What this file does NOT cover is everything a project is needed for: resolving a key, the
 * held-prefix lookup, the missing-scope refusal and the membership-before-lookup ordering. Those
 * are `tests/integration/issue-ref-input-e2e.test.ts`, against real Postgres through the real MCP
 * transport, because each is a claim about what a caller receives from the door.
 */

import { describe, expect, it } from 'vitest';
import {
  ISSUE_REF_CLAUSE,
  ISSUE_REF_INPUTS,
  issueRefSchema,
  isUuid,
  refsFor,
  TASK_REF_INPUTS,
} from './issue-ref-input.js';

const A_UUID = '00000000-0000-4000-8000-0000000000aa';

/** A context and principal no assertion in these cases reaches: every one refuses before scope. */
// biome-ignore lint/suspicious/noExplicitAny: the refusals under test run before either is read
const NO_SCOPE = { principal: {} as any, projectSlug: null } as any;

function refs(action: string) {
  return refsFor({ action }, NO_SCOPE, NO_SCOPE.principal);
}

/** Every `field on actionA/actionB` the clause states, as a flat set of `field action` pairs.
 *  `documentId` appears twice — once for the issues, once for the tasks — so the whole string is
 *  scanned rather than its first hit. */
function pairsInClause(): Set<string> {
  const pairs = new Set<string>();
  for (const [, field, actions] of ISSUE_REF_CLAUSE.matchAll(/([\w.]+) on ([\w/]+)/g)) {
    for (const action of (actions ?? '').split('/')) pairs.add(`${field} ${action}`);
  }
  return pairs;
}

function pairsInRegistry(): Set<string> {
  return new Set([...ISSUE_REF_INPUTS, ...TASK_REF_INPUTS].map((i) => `${i.field} ${i.action}`));
}

describe('the clause and the registry are one string (ISS-1179)', () => {
  it('states exactly the pairs the registry holds, in both directions', () => {
    expect([...pairsInClause()].sort()).toEqual([...pairsInRegistry()].sort());
  });

  it('is what the schema carries into the tool manifest, so a caller reads it beside the field', () => {
    expect(issueRefSchema.description).toBe(ISSUE_REF_CLAUSE);
  });
});

describe('the schema takes what the clause promises (ISS-1179)', () => {
  it.each(['ISS-42', 'FD-7', '42', ' ISS-42 ', A_UUID])('admits %s', (value) => {
    expect(issueRefSchema.safeParse(value).success).toBe(true);
  });

  it('refuses the empty string, which names nothing at all', () => {
    expect(issueRefSchema.safeParse('  ').success).toBe(false);
  });

  it('no longer refuses a display key for not being a uuid, which is the defect', () => {
    expect(isUuid('ISS-1179')).toBe(false);
    expect(issueRefSchema.safeParse('ISS-1179').success).toBe(true);
  });
});

describe('a pair the registry does not hold is refused by name (ISS-1179)', () => {
  it('refuses an issue reference on an action that takes none', async () => {
    await expect(refs('list').issue('documentId', 'ISS-42')).rejects.toThrow(
      /BAD_REQUEST: documentId on action 'list' is not one of this tool's issue references/,
    );
  });

  it('refuses a task reference on an action that takes none', () => {
    expect(() => refs('get').task('documentId', A_UUID)).toThrow(
      /BAD_REQUEST: documentId on action 'get' is not one of this tool's task references/,
    );
  });

  it('carries the clause into that refusal, so the caller is told what IS valid', async () => {
    await expect(refs('create').issue('data.issueId', 'ISS-42')).rejects.toThrow(ISSUE_REF_CLAUSE);
  });
});

describe('a task reference takes the task uuid alone (ISS-1179)', () => {
  it.each(TASK_REF_INPUTS)('$action passes a uuid through untouched', ({ action, field }) => {
    expect(refs(action).task(field, A_UUID)).toBe(A_UUID);
  });

  it.each(TASK_REF_INPUTS)('$action refuses a display key, quoting it', ({ action, field }) => {
    expect(() => refs(action).task(field, 'ISS-42')).toThrow(/`ISS-42` is not a uuid/);
  });

  it('says where the task uuid comes from, rather than only that this one is wrong', () => {
    expect(() => refs('updateTask').task('documentId', 'ISS-42')).toThrow(
      /A task carries no display key.*action 'listTasks' and filters\.issue/s,
    );
  });
});

describe('a uuid reference costs no project scope (ISS-1179)', () => {
  it.each(ISSUE_REF_INPUTS)(
    '$action returns it without reading a project',
    async ({ action, field }) => {
      expect(await refs(action).issue(field, A_UUID)).toBe(A_UUID);
    },
  );
});
