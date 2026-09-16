/**
 * ISS-1051 — the graders are pure: a turn, the text the room delivered, the attempts its trail
 * holds, the seconds it took, the lookups the runner made and the preference rows it gained go in;
 * a verdict with named failure modes and the fact behind each comes out. Nothing here fetches.
 */

import type { REGISTRY_ISSUE_STATUSES } from '@forge/contracts';
import {
  emptyFallbackReply,
  errorFallbackReply,
  unverifiedFallbackReply,
} from '../../conversations/fallback-replies.js';
import { ISSUE_NAV_RE } from '../../messaging/text-rules.js';
import { type Check, type ExpectedRow, fill, type Pattern, type Turn } from './task.js';
import type { Attempt, ToolCall } from './trail.js';

export const FAILURE_MODES = [
  'wrong_link_shape',
  'dead_link',
  'unanswered',
  'language_mismatch',
  'fallback_sent',
  'over_budget',
  'forbidden_tool',
  'missing_tool',
  'help_roundtrip',
  'placeholder_argument',
  'repeated_call',
  'screen_repair',
  'noop_trail_row',
  'preference_not_moved',
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export type LinkOutcome = 'resolves' | 'dead';

export interface PreferenceRow {
  field: string;
  previousValue: string | null;
  newValue: string | null;
}

export interface Evidence {
  mode: FailureMode;
  fact: string;
}

export interface Grade {
  pass: boolean;
  modes: FailureMode[];
  evidence: Evidence[];
}

/** Everything a turn's verdict is read from. */
export interface TurnFacts {
  /** The assistant text the room delivered for the send, or null when it delivered none. */
  delivered: string | null;
  attempts: Attempt[];
  seconds: number;
  budgetSeconds: number;
  /** Placeholder values the fixtures read, for the literal patterns. */
  values: Record<string, string>;
  /** One outcome per issue id the delivered text links; the runner looked each up. */
  lookups: Record<string, LinkOutcome>;
  /** The `preference_changes` rows the trail gained during the send. */
  preferenceRows: PreferenceRow[];
  /** Memory notes the trial kept, as the cleanup counted them; null where the listing was refused or no room was opened (ISS-1064). */
  notesKept: number | null;
}

export class GradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GradeError';
  }
}

export interface IssueLink {
  raw: string;
  hash: boolean;
  slug: string;
  segment: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every Forge issue-navigation target in the text, read with the door's own regex. */
export function extractIssueLinks(text: string): IssueLink[] {
  return [...text.matchAll(ISSUE_NAV_RE)]
    .filter((m) => !m[0].includes('/api/'))
    .map((m) => ({ raw: m[0], hash: m[1] === '#', slug: m[2] ?? '', segment: m[3] ?? '' }));
}

const NAME_TOKEN = ' handle ';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FALLBACK_RES = [errorFallbackReply, unverifiedFallbackReply, emptyFallbackReply].map(
  (build) => new RegExp(`^${build(NAME_TOKEN).split(NAME_TOKEN).map(escapeRe).join('.+?')}$`, 's'),
);

/** Is this one of the texts the door sends when it has no reply it can stand behind? Read from the builders, not copied. */
export function isFallback(text: string): boolean {
  const trimmed = text.trim();
  return FALLBACK_RES.some((re) => re.test(trimmed));
}

// cm:why precomposed code points, not the letters themselves: the Vietnamese alphabet's own vowels (U+00E0–U+01B0) and its tone-marked forms (U+1EA0–U+1EF9), written as escapes so the rule survives any editor's normalisation
const VI_LETTER_RE =
  /[\u00E0-\u00E3\u00E8-\u00EA\u00EC\u00ED\u00F2-\u00F5\u00F9\u00FA\u00FD\u0103\u0111\u0129\u0169\u01A1\u01B0\u1EA0-\u1EF9]/i;

/**
 * A diacritic heuristic and nothing more: after code spans, URLs and double-quoted spans are
 * removed, the words carrying a Vietnamese-only letter or tone mark are counted. A name like
 * Nguyen with its marks in an English sentence is one such word; a Vietnamese answer is many.
 */
export function vietnameseWords(text: string): number {
  const stripped = text
    .normalize('NFC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/["“”][^"“”]*["“”]/g, ' ');
  return stripped.split(/\s+/).filter((w) => VI_LETTER_RE.test(w)).length;
}

type Checker = (check: Check, facts: TurnFacts) => Evidence[];

// cm:guard a literal pattern is matched on a WORD BOUNDARY where it has one, because an issue key
// is a prefix of another issue key: on the QA project, `ISS-2` matched inside `ISS-25` and `ISS-10`
// inside an `ISS-1056` a title carried, so `listInOrder` reported a reply that had listed all five
// in the deployment's own order as naming them out of order, and `open-issues-linked` could not be
// passed at all (0/3, measured against beta 2026-09-16). A pattern that starts or ends on a
// non-word character keeps that end unbounded, since `\b` there asserts the opposite of what is
// meant (ISS-1066).
const literal = (p: Pattern, values: Record<string, string>): RegExp => {
  if (typeof p !== 'string') return p;
  const text = fill(p, values);
  const head = /^\w/.test(text) ? '\\b' : '';
  const tail = /\w$/.test(text) ? '\\b' : '';
  return new RegExp(`${head}${escapeRe(text)}${tail}`);
};

const forgeCalls = (attempts: Attempt[]): ToolCall[] =>
  attempts.flatMap((a) => a.calls).filter((c) => c.name === 'forge' && c.argv !== null);

const allCalls = (attempts: Attempt[]): ToolCall[] => attempts.flatMap((a) => a.calls);

const isHelp = (call: ToolCall): boolean =>
  (call.argv ?? []).some((a) => a === '-h' || a === '--help');

const unanswered = (fact: string): Evidence[] => [{ mode: 'unanswered', fact }];

type RegistryStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

/**
 * The registry's status names, inlined rather than imported.
 * cm:guard core value-imports nothing from `@forge/contracts` (the production image ships no
 * contracts package; `contracts-runtime-boundary.test.ts`), so the list is a copy typed against the
 * contract, and `grade-only-from.test.ts` holds it equal to `REGISTRY_ISSUE_STATUSES` member for member.
 */
export const ONLY_FROM_STATUSES = [
  'open',
  'confirmed',
  'clarified',
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'testing',
  'tested',
  'awaiting_release',
  'releasing',
  'closed',
  'reopen',
  'on_hold',
  'needs_info',
  'draft',
  'dropped',
] as const satisfies readonly RegistryStatus[];

/** Every registry status name the text carries as a whole word (`_` is part of the word, so `in_progress` is one token and `progress` none). */
function stateTokens(text: string): string[] {
  return ONLY_FROM_STATUSES.filter((s) => new RegExp(`(?<![\\w])${s}(?![\\w])`).test(text));
}

/** A clause ends at a line break, a full stop, a semicolon, a comma, a slash or the word "and"; a pipe is not a break, so a table cell pairs with its row's label. */
const CLAUSE_BREAK = /[\n.;,/]|\band\b/i;

/**
 * The number each occurrence of the label stands with: the first number after it in the same
 * clause, or, only when the clause after it holds none, the last number before it in its clause.
 * One direction per occurrence, so "Open: 1 and closed: 0" pairs closed with 0, never with the 1
 * that precedes it (codex F2 on ISS-1061).
 */
function labelPairs(text: string, label: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(label.source, label.flags.includes('i') ? 'gi' : 'g');
  for (const m of text.matchAll(re)) {
    const after = text.slice(m.index + m[0].length);
    const stop = CLAUSE_BREAK.exec(after);
    const next = /\d+/.exec(stop ? after.slice(0, stop.index) : after);
    if (next) {
      out.push(next[0]);
      continue;
    }
    const before = text.slice(0, m.index);
    const clause = before.split(CLAUSE_BREAK).at(-1) ?? '';
    const previous = clause.match(/\d+/g)?.at(-1);
    if (previous) out.push(previous);
  }
  return out;
}

/** Every pattern matches and each first match lies after the one before it; the order fact names the filled value. */
function ordered(text: string, patterns: Pattern[], values: Record<string, string>): Evidence[] {
  const out: Evidence[] = [];
  const shown = (p: Pattern): string => (typeof p === 'string' ? fill(p, values) : String(p));
  let cursor = -1;
  let previous = '';
  for (const p of patterns) {
    const m = literal(p, values).exec(text);
    if (!m) {
      out.push({ mode: 'unanswered', fact: `reply does not match ${String(p)}` });
      continue;
    }
    if (m.index < cursor)
      out.push({ mode: 'unanswered', fact: `reply names ${shown(p)} before ${previous}` });
    cursor = Math.max(cursor, m.index);
    previous = shown(p);
  }
  return out;
}

const checkers: Record<Check['kind'], Checker> = {
  linkShape: (_c, f) =>
    extractIssueLinks(f.delivered ?? '').flatMap((link) => {
      if (link.hash)
        return [{ mode: 'wrong_link_shape', fact: `hash-prefixed navigation target ${link.raw}` }];
      if (!UUID_RE.test(link.segment))
        return [{ mode: 'wrong_link_shape', fact: `issue segment is not a UUID: ${link.raw}` }];
      return [];
    }),
  linksResolve: (_c, f) =>
    extractIssueLinks(f.delivered ?? '')
      .filter((link) => UUID_RE.test(link.segment))
      .flatMap((link) => {
        const outcome = f.lookups[link.segment];
        if (outcome === undefined)
          throw new GradeError(`no lookup outcome for linked issue ${link.segment}`);
        return outcome === 'dead' ? [{ mode: 'dead_link', fact: `${link.raw} answered 404` }] : [];
      }),
  mustMatch: (c, f) => {
    if (c.kind !== 'mustMatch') return [];
    if (f.delivered === null) return unanswered('no assistant message delivered');
    const text = f.delivered;
    return c.patterns
      .filter((p) => !literal(p, f.values).test(text))
      .map((p) => ({ mode: 'unanswered', fact: `reply does not match ${String(p)}` }));
  },
  inOrder: (c, f) => {
    if (c.kind !== 'inOrder') return [];
    if (f.delivered === null) return unanswered('no assistant message delivered');
    return ordered(f.delivered, c.patterns, f.values);
  },
  listInOrder: (c, f) => {
    if (c.kind !== 'listInOrder') return [];
    if (f.delivered === null) return unanswered('no assistant message delivered');
    return ordered(f.delivered, fill(c.list, f.values).split(', '), f.values);
  },
  labeled: (c, f) => {
    if (c.kind !== 'labeled') return [];
    if (f.delivered === null) return unanswered('no assistant message delivered');
    const value = fill(c.value, f.values);
    return labelPairs(f.delivered, c.label).some((n) => n === value)
      ? []
      : unanswered(`reply does not pair ${String(c.label)} with ${value}`);
  },
  maxNotesKept: (c, f) => {
    if (c.kind !== 'maxNotesKept') return [];
    if (f.notesKept === null)
      return [
        { mode: 'repeated_call', fact: 'notes kept unknown: the memory listing was refused' },
      ];
    if (f.notesKept > c.max)
      return [
        {
          mode: 'repeated_call',
          fact: `kept ${f.notesKept} note(s), at most ${c.max} allowed`,
        },
      ];
    return [];
  },
  onlyFrom: (c, f) => {
    if (c.kind !== 'onlyFrom') return [];
    if (f.delivered === null) return unanswered('no assistant message delivered');
    const list = fill(c.list, f.values);
    const allowed = new Set(list.split(', '));
    return [...new Set(stateTokens(f.delivered))]
      .filter((s) => !allowed.has(s))
      .map((s) => ({
        mode: 'unanswered' as const,
        fact: `reply names state ${s} outside ${list}`,
      }));
  },
  linkTo: (c, f) => {
    if (c.kind !== 'linkTo') return [];
    if (f.delivered === null) return unanswered('no assistant message delivered');
    const id = fill(c.issueId, f.values);
    return extractIssueLinks(f.delivered).some((l) => l.segment === id)
      ? []
      : unanswered(`no link to issue ${id}`);
  },
  mustNotMatch: (c, f) => {
    if (c.kind !== 'mustNotMatch') return [];
    const text = f.delivered ?? '';
    return c.patterns
      .filter((p) => literal(p, f.values).test(text))
      .map((p) => ({ mode: 'unanswered', fact: `reply matches forbidden ${String(p)}` }));
  },
  language: (c, f) => {
    if (c.kind !== 'language') return [];
    const n = vietnameseWords(f.delivered ?? '');
    if (c.diacritics === 'vi' && n < 3)
      return [
        { mode: 'language_mismatch', fact: `${n} word(s) with Vietnamese diacritics, vi needs 3` },
      ];
    if (c.diacritics === 'en' && n >= 2)
      return [
        {
          mode: 'language_mismatch',
          fact: `${n} word(s) with Vietnamese diacritics in an en reply`,
        },
      ];
    return [];
  },
  notFallback: (_c, f) => {
    if (f.delivered === null) return unanswered('no assistant message delivered');
    return isFallback(f.delivered)
      ? [
          {
            mode: 'fallback_sent',
            fact: `delivered the door's fallback: ${f.delivered.slice(0, 60)}`,
          },
        ]
      : [];
  },
  maxSeconds: (_c, f) =>
    f.seconds > f.budgetSeconds
      ? [
          {
            mode: 'over_budget',
            fact: `${f.seconds.toFixed(1)}s over a ${f.budgetSeconds}s budget`,
          },
        ]
      : [],
  toolsAllowed: (c, f) => {
    if (c.kind !== 'toolsAllowed') return [];
    const allowed = new Set(c.tools);
    return allCalls(f.attempts)
      .filter((call) => !allowed.has(call.name))
      .map((call) => ({ mode: 'forbidden_tool', fact: `called ${call.name}` }));
  },
  toolsRequired: (c, f) => {
    if (c.kind !== 'toolsRequired') return [];
    const called = new Set(allCalls(f.attempts).map((call) => call.name));
    return c.tools
      .filter((t) => !called.has(t))
      .map((t) => ({ mode: 'missing_tool', fact: `never called ${t}` }));
  },
  argvNotMatch: (c, f) => {
    if (c.kind !== 'argvNotMatch') return [];
    // cm:why a help call is not the verb: `forge new -h` files nothing, and `noHelp` already names it as a roundtrip — counting it here too would fail a reply that did exactly what was asked
    return forgeCalls(f.attempts)
      .filter((call) => !isHelp(call) && c.pattern.test(call.argv?.[0] ?? ''))
      .map((call) => ({ mode: 'forbidden_tool', fact: `forge ${call.argv?.join(' ')}` }));
  },
  noHelp: (_c, f) =>
    forgeCalls(f.attempts)
      .filter(isHelp)
      .map((call) => ({ mode: 'help_roundtrip', fact: `forge ${call.argv?.join(' ')}` })),
  noPlaceholder: (_c, f) =>
    forgeCalls(f.attempts)
      .filter((call) => (call.argv ?? []).some((a) => /^ISS-\?$|<[^<>]+>/.test(a)))
      .map((call) => ({ mode: 'placeholder_argument', fact: `forge ${call.argv?.join(' ')}` })),
  noRepeatedCall: (_c, f) => {
    const seen = new Set<string>();
    const out: Evidence[] = [];
    for (const call of allCalls(f.attempts)) {
      const key = `${call.name} ${call.arguments}`;
      if (seen.has(key)) out.push({ mode: 'repeated_call', fact: key.slice(0, 120) });
      seen.add(key);
    }
    return out;
  },
  maxCalls: (c, f) => {
    if (c.kind !== 'maxCalls') return [];
    const n = allCalls(f.attempts).length;
    return n > c.max ? [{ mode: 'over_budget', fact: `${n} tool calls, budget ${c.max}` }] : [];
  },
  maxIterations: (c, f) => {
    if (c.kind !== 'maxIterations') return [];
    const n = f.attempts.reduce((sum, a) => sum + a.iterations, 0);
    return n > c.max ? [{ mode: 'over_budget', fact: `${n} iterations, budget ${c.max}` }] : [];
  },
  screenRepair: (_c, f) =>
    f.attempts.length >= 2
      ? [{ mode: 'screen_repair', fact: `${f.attempts.length} attempts for one send` }]
      : [],
  preferenceRows: (c, f) => (c.kind === 'preferenceRows' ? preferenceRows(c.rows, f) : []),
};

function rowMatches(expected: ExpectedRow, row: PreferenceRow): boolean {
  if (row.field !== expected.field) return false;
  if (expected.newValue !== undefined && row.newValue !== expected.newValue) return false;
  if (expected.previousValue !== undefined && row.previousValue !== expected.previousValue)
    return false;
  return true;
}

function preferenceRows(expected: ExpectedRow[], f: TurnFacts): Evidence[] {
  const out: Evidence[] = [];
  const claimed = new Set<number>();
  for (const exp of expected) {
    const index = f.preferenceRows.findIndex((row, i) => !claimed.has(i) && rowMatches(exp, row));
    if (index === -1)
      out.push({ mode: 'preference_not_moved', fact: `no row ${JSON.stringify(exp)}` });
    else claimed.add(index);
  }
  f.preferenceRows.forEach((row, i) => {
    if (!claimed.has(i))
      out.push({ mode: 'noop_trail_row', fact: `unexpected row ${JSON.stringify(row)}` });
  });
  return out;
}

/** The verdict on one turn; every mode carries the fact a reader can point at. */
export function gradeTurn(turn: Turn, facts: TurnFacts): Grade {
  const evidence = turn.checks.flatMap((check) => checkers[check.kind](check, facts));
  const modes = [...new Set(evidence.map((e) => e.mode))];
  return { pass: modes.length === 0, modes, evidence };
}
