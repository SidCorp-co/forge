/**
 * ISS-984 trimmed `forge_issues`' description from 6,381 characters to 4,047
 * and reordered it. Length is the cheap half: the chat door truncates every
 * description at `DESCRIPTION_CAP`, so a rule's POSITION decides whether the
 * model reading it ever sees the rule at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { DESCRIPTION_CAP } from '../../assistant/tools/mcp-adapter.js';
import { makeFakePrincipal } from '../fake-principal.fixture.js';
import {
  DESCRIPTION_AT_B4850A2E,
  INPUT_SCHEMA_JSON_AT_B4850A2E,
} from './forge-issues-b4850a2e.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { forgeIssuesTool } = await import('./forge-issues.js');

const tool = forgeIssuesTool({
  principal: makeFakePrincipal('token', 'user'),
  projectSlug: 'forge-dev',
  boundProjectId: null,
});
const live = tool.description;

// cm:guard each check reads the RULE, not the wording ISS-984 happened to choose: every one of the four passes against the b4850a2e text below as well as the live one, which is what stops a check from degenerating into a spelling assertion of the current file.
type RuleCheck = {
  readonly id: string;
  readonly present: (text: string) => boolean;
  /** the live sentence the mutation tests delete, to prove the check bites */
  readonly sentence: RegExp;
  /** vocabulary kept, obligation reversed */
  readonly negate: (text: string) => string;
};

const RULES: readonly RuleCheck[] = [
  {
    id: 'list REFUSES filters.issue',
    present: (t) =>
      /filters\.issue[\s\S]{0,120}?REFUSES?|REFUSES?[\s\S]{0,120}?filters\.issue/.test(t) &&
      /filters\.taskStatus/.test(t),
    sentence: /list REFUSES filters\.issue and filters\.taskStatus[^.]*\.\s*/,
    negate: (t) => t.replace('list REFUSES filters.issue', 'list ACCEPTS filters.issue'),
  },
  {
    id: 'list is a projection, get is the body',
    present: (t) =>
      /\blist\b[^.;—]{0,120}\bprojection\b/.test(t) &&
      (/\bget\b[^.;—]{0,80}\bbody\b/.test(t) || /\bbody\b[^.;—]{0,80}\bget\b/.test(t)),
    sentence: /list returns a summary projection[\s\S]*?already loaded this session\.\s*/,
    negate: (t) =>
      t
        .replace('list returns a summary projection', 'list returns the full body')
        .replace('get returns the full body', 'get returns a summary projection'),
  },
  {
    id: 'hasMore before a count is called complete',
    present: (t) => /hasMore[^.]{0,90}\bbefore\b[^.]{0,90}\bcomplete\b/.test(t),
    sentence: /Every list response carries returned\/limit\/hasMore[\s\S]*?which cap bit\.\s*/,
    negate: (t) => t.replace('read hasMore before reporting', 'read hasMore after reporting'),
  },
  {
    id: 'plan/acceptanceCriteria are the pipeline’s, pre-filling is plan-by-hand',
    present: (t) =>
      /acceptanceCriteria[\s\S]{0,240}?pre-filling[\s\S]{0,160}?(red flag[^.]{0,40}plan-by-hand|plan-by-hand red flag)/.test(
        t,
      ) && !/\bnot the plan-by-hand\b|\bpre-filling them is expected\b/.test(t),
    sentence:
      /On create send title\/description\/priority\/category[\s\S]*?plan-by-hand red flag\.\s*/,
    negate: (t) =>
      t.replace(
        'is the plan-by-hand red flag',
        'is not the plan-by-hand red flag, but the shortcut',
      ),
  },
];

const CAPPED = (t: string) => t.slice(0, DESCRIPTION_CAP);

describe('the forge_issues description carries its operative rules', () => {
  it.each(RULES.map((r) => [r.id, r] as const))('%s survives in the live text', (_id, rule) => {
    expect(rule.present(live)).toBe(true);
  });

  it.each(RULES.map((r) => [r.id, r] as const))(
    '%s reaches the chat door, inside DESCRIPTION_CAP',
    (_id, rule) => {
      expect(rule.present(CAPPED(live))).toBe(true);
    },
  );

  it.each(RULES.map((r) => [r.id, r] as const))(
    'deleting %s is reported, and reports nothing else',
    (_id, rule) => {
      const without = live.replace(rule.sentence, '');
      expect(without).not.toBe(live);
      expect(rule.present(without)).toBe(false);
      for (const other of RULES) {
        if (other.id !== rule.id) expect(other.present(without)).toBe(true);
      }
    },
  );

  it.each(RULES.map((r) => [r.id, r] as const))(
    'negating %s is reported, with its vocabulary left in place',
    (_id, rule) => {
      const reversed = rule.negate(live);
      expect(reversed).not.toBe(live);
      expect(reversed.length).toBeGreaterThan(live.length - 40);
      expect(rule.present(reversed)).toBe(false);
    },
  );
});

describe('the same checks read the b4850a2e text they were derived from', () => {
  it.each(RULES.map((r) => [r.id, r] as const))('%s was there too', (_id, rule) => {
    expect(rule.present(DESCRIPTION_AT_B4850A2E)).toBe(true);
  });

  // cm:guard this is the defect ISS-984 removes, asserted as a fact about the OLD text — a run that "fixes" this expectation to green has deleted the only evidence that the reordering was worth doing.
  it('but two of them fell past the cap, which is why the order moved', () => {
    const old = CAPPED(DESCRIPTION_AT_B4850A2E);
    const reported = Object.fromEntries(RULES.map((r) => [r.id, r.present(old)]));
    expect(reported).toEqual({
      'list REFUSES filters.issue': true,
      'list is a projection, get is the body': true,
      'hasMore before a count is called complete': false,
      'plan/acceptanceCriteria are the pipeline’s, pre-filling is plan-by-hand': false,
    });
  });
});

describe('what the chat door drops on the floor', () => {
  // cm:guard `buildToolset` appends spec.describe AFTER the description and truncates the pair at DESCRIPTION_CAP, so on a tool this long that note never arrives: measured 2026-09-12, the model answered "Show me the full description of ISS-742" with a list+search on both the b4850a2e text and this one until the same fact was moved inside the cap, after which it called get with documentId directly. The duplication is deliberate while the adapter appends rather than prepends.
  it('says inside the cap that documentId takes the short ISS-<n> id', () => {
    expect(CAPPED(live)).toContain('ISS-<n>');
  });
});

describe('what ISS-984 promised it would not move', () => {
  it('leaves inputSchema byte-identical to b4850a2e', () => {
    expect(JSON.stringify(tool.inputSchema)).toBe(INPUT_SCHEMA_JSON_AT_B4850A2E);
  });

  it('costs materially fewer characters than the text it replaced', () => {
    expect(DESCRIPTION_AT_B4850A2E.length).toBe(6381);
    expect(live.length).toBeLessThan(4200);
  });
});
