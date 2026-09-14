import { describe, expect, it } from 'vitest';
import { ISSUE_REFERENCES_EXIST } from './claim-rules.js';
import { type MessageRule, problemsOf } from './contract.js';
import { type MessageFacts, facts as mkFacts, type ProgressFacts } from './facts.js';
import { extractIssueClaims, turnCreatedIssue } from './issue-tokens.js';
import { LEGACY_KNOWN, LEGACY_PREFIX, LEGACY_PREFIXES } from './legacy-corpus.js';
import fixture from './legacy-verdicts.fixture.json' with { type: 'json' };
import { PROGRESS_FIGURES_MATCH } from './progress-rule.js';
import { screenMessage } from './screen.js';
import {
  COMMENT_HAS_TEXT,
  NO_DEVELOPER_DETAIL,
  NO_EMPTY_PROMISE,
  NO_ROOM_BROADCAST_CARRIED,
  ONLY_VERIFIED_CITATIONS,
} from './text-rules.js';

type Row = (typeof fixture.rows)[number];

const base = (over: Partial<MessageFacts> = {}): MessageFacts =>
  mkFacts({
    prefix: LEGACY_PREFIX,
    prefixes: LEGACY_PREFIXES,
    knownIssueIds: LEGACY_KNOWN.ids,
    knownIssueSeqs: LEGACY_KNOWN.seqs,
    ...over,
  });

/** Re-read a row's input back out of the key the harness wrote it under. */
function parts(row: Row): unknown[] {
  return row.input.split(' | ').map((p) => JSON.parse(p));
}

const rulesVerdict = (rules: readonly MessageRule[], text: string, f: MessageFacts) => {
  const problems = rules.flatMap((r) => r.check(text, f).map((b) => b.why));
  return { ok: problems.length === 0, problems };
};

const RUNNERS: Record<string, (row: Row) => unknown> = {
  extractIssueClaims: (row) => {
    const [text, prefixes] = parts(row) as [string, string[]];
    return extractIssueClaims(text, prefixes);
  },
  turnCreatedIssue: (row) => {
    const [calls] = parts(row) as [{ name: string; arguments: string }[]];
    return turnCreatedIssue(calls);
  },
  judgeIssueClaims: (row) => {
    const [text, calls] = parts(row) as [string, { name: string; arguments: string }[]];
    return rulesVerdict([ISSUE_REFERENCES_EXIST], text, base({ toolCalls: calls }));
  },
  lintStakeholderReply: (row) => {
    const [text, skip] = parts(row) as [string, boolean];
    return rulesVerdict(
      [NO_DEVELOPER_DETAIL, ONLY_VERIFIED_CITATIONS],
      text,
      base({ issueLookupFailed: skip }),
    );
  },
  detectEmptyPromise: (row) => {
    const [text] = parts(row) as [string];
    return rulesVerdict([NO_EMPTY_PROMISE], text, base());
  },
  checkProgressClaims: (row) => {
    const [text, progress] = parts(row) as [string, ProgressFacts | null];
    return rulesVerdict([PROGRESS_FIGURES_MATCH], text, base({ progress }));
  },
  screenCarriedComment: (row) => {
    const [text] = parts(row) as [string];
    const first = COMMENT_HAS_TEXT.check(text, base());
    if (first.length > 0) return { ok: false, problems: first.map((b) => b.why) };
    return rulesVerdict([NO_ROOM_BROADCAST_CARRIED], text, base());
  },
  screenOperatorMessage: (row) => {
    const [segments] = parts(row) as [string[]];
    const verdict = screenMessage({
      audience: 'role',
      intent: 'ask',
      segments,
      facts: base(),
    });
    return { ok: verdict.ok, problems: problemsOf(verdict) };
  },
};

describe('the cells reproduce the rule bodies they replaced', () => {
  it('covers every rule the baseline froze', () => {
    const frozen = new Set(fixture.rows.map((r) => r.rule));
    expect([...frozen].sort()).toEqual(Object.keys(RUNNERS).sort());
  });

  for (const rule of new Set(fixture.rows.map((r) => r.rule))) {
    it(`gives the frozen verdict for every ${rule} input`, () => {
      const rows = fixture.rows.filter((r) => r.rule === rule);
      expect(rows.length).toBeGreaterThan(0);
      const runner = RUNNERS[rule];
      if (!runner) throw new Error(`no runner for ${rule}`);
      for (const row of rows) {
        expect({ input: row.input, verdict: runner(row) }).toEqual({
          input: row.input,
          verdict: row.verdict,
        });
      }
    });
  }
});
