/**
 * The obligations `forge_issues`' description carries, and the window the chat
 * door reads them through.
 *
 * A description is prose: nothing else in the build notices a rule leaving it.
 * Each rule below is one obligation the tool's callers act on, matched against
 * the live description and planted against in the same file — deleted, and
 * negated with its vocabulary left in place — because a presence check that
 * cannot go red is not evidence the rule is there.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why the factory pulls in `db/client.js` through the issue services, which validates the real environment at import; this is the same stub `forge-issues.test.ts` uses, and none of the checks below reach a database
vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

import { DESCRIPTION_CAP } from '../../assistant/tools/mcp-adapter.js';
import { forgeIssuesTool } from './forge-issues.js';
import type { McpContext } from './lib.js';

/** Backticks and line breaks are formatting, not content: match through them. */
function normalizeDescription(text: string): string {
  return text.replace(/`/g, '').replace(/\s+/g, ' ');
}

interface OperativeRule {
  /** What a caller does differently because the description says this. */
  readonly states: string;
  /** Every pattern must hit, so a half-stated rule reads as missing. */
  readonly patterns: readonly RegExp[];
  /** None may hit. A rule whose vocabulary survives its own reversal is what these refuse. */
  readonly forbids: readonly RegExp[];
  /** The span that carries it in the live description, removed to plant its absence. */
  readonly span: string;
  /** The same span with the obligation reversed and its vocabulary kept. */
  readonly negated: string;
  /** The reversal that keeps every matched phrase in place, which is the one a keyword check misses. */
  readonly negatedInPlace: string;
}

// cm:guard these four are the rules ISS-984 compressed the description AROUND, so a trim that drops one is the trim failing. Adding a fifth is fine; deleting one of these needs the issue that argues the caller no longer needs it.
const OPERATIVE_RULES: Record<string, OperativeRule> = {
  'list-refuses-filters-issue': {
    states: 'list refuses filters.issue and filters.taskStatus; they belong to listTasks',
    patterns: [/filters\.issue[\s\S]{0,140}?refuses/i],
    forbids: [/(?:never|not|does not|doesn't)\s+refuses?/i],
    span: 'filters.issue and filters.taskStatus belong to listTasks - list REFUSES them, use get.',
    negated: 'filters.issue and filters.taskStatus are accepted by list as well as by listTasks.',
    negatedInPlace:
      'filters.issue and filters.taskStatus belong to listTasks - list never REFUSES them, use get.',
  },
  'list-projects-get-returns-body': {
    states: 'list returns a projection and get returns the full body',
    patterns: [
      /list returns a(?:\s+\w+)? summary projection/i,
      /get returns the full body|full body with action=get/i,
    ],
    forbids: [/non-summary/i, /list returns the full body/i],
    span:
      'list returns a summary projection - it omits the five heavy fields the fields enum ' +
      'names - to stay under the response token cap; get returns the full body.',
    negated: 'list returns the full body of every issue; get returns a summary projection of one.',
    negatedInPlace:
      'list returns a non-summary projection - it omits the five heavy fields the fields enum ' +
      'names - to stay under the response token cap; get returns the full body.',
  },
  'has-more-before-a-count': {
    states: 'hasMore is read before a count is reported complete',
    patterns: [/read hasMore before[\s\S]{0,60}?count/i],
    forbids: [/(?:never|do not|don't)\s+read hasMore/i, /ignore hasMore/i],
    span:
      'Read hasMore before calling any count complete: a list cut short by your own limit ' +
      'looks exactly like a complete one.',
    negated:
      'Ignore hasMore when calling a count complete: a list cut short by your own limit ' +
      'is obvious from its rows.',
    negatedInPlace:
      'Never read hasMore before calling any count complete: a list cut short by your own ' +
      'limit looks exactly like a complete one.',
  },
  'plan-and-criteria-are-the-pipelines': {
    states:
      'plan and acceptanceCriteria are written by the pipeline, and pre-filling them is a red flag',
    patterns: [
      /plan and acceptanceCriteria are(?:\s+written by)? the clarify\/plan steps/i,
      /pre-filling them[\s\S]{0,90}?red flag: plan-by-hand/i,
    ],
    forbids: [/are not[\s\S]{0,25}?the clarify\/plan steps/i, /not a red flag/i],
    span:
      "plan and acceptanceCriteria are the clarify/plan steps' output - pre-filling them " +
      "deletes that step's reason to exist (red flag: plan-by-hand).",
    negated:
      'plan and acceptanceCriteria may be filled at create time; pre-filling them saves the ' +
      'clarify/plan steps a round.',
    negatedInPlace:
      "plan and acceptanceCriteria are not the clarify/plan steps' output - pre-filling them " +
      'is not a red flag: plan-by-hand.',
  },
};

function ruleHolds(rule: OperativeRule, text: string): boolean {
  const normalized = normalizeDescription(text);
  if (rule.forbids.some((p) => p.test(normalized))) return false;
  return rule.patterns.every((p) => p.test(normalized));
}

const description = forgeIssuesTool({ boundProjectId: null } as unknown as McpContext).description;
const entries = Object.entries(OPERATIVE_RULES);

describe('forge_issues description — the rules it must still carry', () => {
  it.each(entries)('states %s', (_key, rule) => {
    expect(ruleHolds(rule, description)).toBe(true);
  });

  // cm:guard the window, not the whole string: `buildToolset` truncates at DESCRIPTION_CAP, so a rule ordered past the cut is a rule the chat model never reads however plainly the file states it.
  it.each(entries)('states %s inside the chat door window', (_key, rule) => {
    expect(ruleHolds(rule, description.slice(0, DESCRIPTION_CAP))).toBe(true);
  });

  it.each(entries)('carries %s in one findable span', (_key, rule) => {
    expect(description).toContain(rule.span);
  });
});

describe('forge_issues description — each check goes red on its own', () => {
  it.each(entries)('reads %s as missing once its span is deleted', (_key, rule) => {
    const planted = description.replace(rule.span, '');
    expect(ruleHolds(rule, planted)).toBe(false);
  });

  it.each(entries)('reads only %s as missing once its span is deleted', (key, rule) => {
    const planted = description.replace(rule.span, '');
    for (const [otherKey, other] of entries) {
      if (otherKey === key) continue;
      expect(ruleHolds(other, planted)).toBe(true);
    }
  });

  it.each(entries)('reads %s as missing once its obligation is reversed', (_key, rule) => {
    const planted = description.replace(rule.span, rule.negated);
    expect(ruleHolds(rule, planted)).toBe(false);
  });

  // cm:guard the reversal that keeps EVERY matched phrase in place is the one a keyword check waves through, so it is the one that has to be planted: `list never REFUSES them` carries `filters.issue` and `refuses` and means the opposite.
  it.each(entries)('reads %s as missing once its obligation is negated in place', (_key, rule) => {
    const planted = description.replace(rule.span, rule.negatedInPlace);
    expect(planted).not.toBe(description);
    expect(ruleHolds(rule, planted)).toBe(false);
  });
});

describe('forge_issues description — what it costs to ship', () => {
  // cm:guard the ceiling is ISS-984's acceptance criterion, not a style preference: this description is 46% of the nine-tool chat catalog and every turn pays for it.
  it('stays under the 4,200 characters ISS-984 bought it down to', () => {
    expect(description.length).toBeLessThan(4_200);
  });
});
