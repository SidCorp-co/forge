// Which issues a commit's subject declares, by the project's issue keys: read by the merge identity
// (`issues/merge-identity.ts`) and the commit-landing check (`issues/commit-landing.ts`).

import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pattern matching a reference under any of `prefixes` or the shared legacy one. */
export function issueRefPattern(prefixes: readonly string[]): RegExp {
  const all = [...new Set([...prefixes, LEGACY_ISSUE_PREFIX].map((p) => p.toUpperCase()))];
  return new RegExp(
    `(?<![A-Za-z0-9])(?:${all.map(escapeRe).join('|')})-(\\d{1,10})(?![A-Za-z0-9])`,
    'gi',
  );
}

const PR_REF_TAIL = /(?:\s*\(#\d+\))+\s*$/;
const TRAILER = /\(([^()]*)\)\s*$/;
const PR_MERGE = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/;
const BRANCH_MERGE = /^Merge (?:remote-tracking )?branch (?:'([^']+)'|(\S+))/;
const LOCAL_MERGE = /^Merge branch '?([^'\s]+)'?/;
const REMOTE_MERGE = /^Merge remote-tracking branch '([^'\s]+)'/;
const BARE_MERGE = /^Merge (?!branch |remote-tracking |pull request )([^'\s]+)/;
const MERGE_LEAD = /^Merge\s+/;
const LABEL_LEAD = /^[\w.-]+(?:\([^)]*\))?!?:\s*/;

export function subjectOf(message: string): string {
  return message.split('\n', 1)[0]?.trim() ?? '';
}

function lastSegment(ref: string): string {
  return ref.split('/').pop() ?? '';
}

/**
 * Whether the subject merges the base branch into another one. Git names a local branch as it is
 * and a remote-tracking one as `<remote>/<name>`; a hand-written `Merge <ref> into …` is read as
 * local unless it is qualified by `origin`, since a topic branch may itself end in the base's name.
 */
function mergesBase(subject: string, base: string): boolean {
  const remote = REMOTE_MERGE.exec(subject)?.[1];
  if (remote !== undefined) return remote.slice(remote.indexOf('/') + 1) === base;
  const local = LOCAL_MERGE.exec(subject)?.[1];
  if (local !== undefined) return local === base;
  const bare = BARE_MERGE.exec(subject)?.[1];
  return bare === base || bare === `origin/${base}`;
}

function seqsIn(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((m) => Number(m[1]));
}

const leadingLists = new Map<string, RegExp>();

/** The keys that open `text`, joined by `,`, `+`, `&`, `/` or `and`, and none past the first gap. */
function leadingSeqs(text: string, pattern: RegExp): number[] {
  let list = leadingLists.get(pattern.source);
  if (!list) {
    const ref = pattern.source;
    list = new RegExp(`^(?:${ref})(?:(?:\\s*[,+&/]\\s*|\\s+and\\s+)(?:${ref}))*`, 'i');
    leadingLists.set(pattern.source, list);
  }
  const m = list.exec(text);
  return m ? seqsIn(m[0], pattern) : [];
}

/**
 * The issues a commit's subject declares. A key is declared in the parenthesised group ending the
 * subject; failing that, for a merge subject, at the start of the merged branch's name; failing
 * that, in the keys opening the subject after any `Merge` or `type(scope):` lead. A merge of the
 * base branch into another branch declares nothing: what it carries is placed by its own commits.
 * A key anywhere else in the subject, or in the body, is a citation and declares nothing.
 */
export function declaredIssueSeqs(message: string, pattern: RegExp, baseBranch: string): number[] {
  const subject = subjectOf(message);
  if (mergesBase(subject, baseBranch)) return [];

  const trailer = TRAILER.exec(subject.replace(PR_REF_TAIL, ''));
  const trailed = trailer?.[1] ? seqsIn(trailer[1], pattern) : [];
  if (trailed.length > 0) return trailed;

  const merged = PR_MERGE.exec(subject) ?? BRANCH_MERGE.exec(subject);
  const branch = merged?.[1] ?? merged?.[2];
  if (branch) {
    const fromBranch = leadingSeqs(lastSegment(branch), pattern).slice(0, 1);
    if (fromBranch.length > 0) return fromBranch;
  }

  const rest = subject.replace(MERGE_LEAD, '');
  const opening = leadingSeqs(rest, pattern);
  return opening.length > 0 ? opening : leadingSeqs(rest.replace(LABEL_LEAD, ''), pattern);
}
