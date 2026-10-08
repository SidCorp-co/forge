// MJ-3: a memory is only as true as the records it names. Every read that shows one to a person or
// an agent resolves the issue and requirement keys its text cites, and each that no longer resolves
// (no such record, dropped, archived) is named on the row as why it reads stale. Derived on read,
// never stored, so it cannot drift, and it never archives or deletes the row: a person corrects or
// retires it on the Memory page.

import type { MemoryStaleRef } from '@forge/contracts/memory';
import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { memoryIssueReads } from './ports.js';

const KEY_RE = /\b([A-Z][A-Z0-9]{1,5})-(\d{1,6})\b/g;
const REQUIREMENT_PREFIX = 'REQ';

/** The keys one memory text names, by kind, in the order they first appear. */
export interface CitedKeys {
  issues: { ref: string; seq: number }[];
  requirements: { ref: string; seq: number }[];
}

/** The issue and requirement keys a text cites, given the issue prefixes the project answers to. */
export function citedKeys(text: string, issuePrefixes: ReadonlySet<string>): CitedKeys {
  const out: CitedKeys = { issues: [], requirements: [] };
  const seen = new Set<string>();
  for (const m of text.matchAll(KEY_RE)) {
    const [ref, prefix, n] = m;
    if (!prefix || !n || seen.has(ref)) continue;
    const seq = Number(n);
    if (prefix === REQUIREMENT_PREFIX) {
      seen.add(ref);
      out.requirements.push({ ref, seq });
    } else if (issuePrefixes.has(prefix)) {
      seen.add(ref);
      out.issues.push({ ref, seq });
    }
  }
  return out;
}

/** What the project holds for the keys a page of memories cites. */
export interface CitedStandings {
  issues: ReadonlyMap<number, { status: string; archived: boolean }>;
  requirements: ReadonlyMap<number, string>;
}

/** Each cited key that no longer resolves, and why; closed issues and deferred requirements still resolve. */
export function staleRefsOf(cited: CitedKeys, held: CitedStandings): MemoryStaleRef[] {
  const out: MemoryStaleRef[] = [];
  for (const { ref, seq } of cited.issues) {
    const row = held.issues.get(seq);
    if (!row) out.push({ ref, kind: 'issue', why: 'missing' });
    else if (row.archived) out.push({ ref, kind: 'issue', why: 'archived' });
    else if (row.status === 'dropped') out.push({ ref, kind: 'issue', why: 'dropped' });
  }
  for (const { ref, seq } of cited.requirements) {
    const status = held.requirements.get(seq);
    if (status === undefined) out.push({ ref, kind: 'requirement', why: 'missing' });
    else if (status === 'dropped') out.push({ ref, kind: 'requirement', why: 'dropped' });
  }
  return out;
}

/** The issue prefixes a memory's text is read against: every one held, and `ISS` while it renders. */
export function issuePrefixSet(p: { active: string | null; held: readonly string[] }): Set<string> {
  const set = new Set(p.held.map((h) => h.toUpperCase()));
  if (p.active === null) set.add(LEGACY_ISSUE_PREFIX);
  else set.add(p.active.toUpperCase());
  return set;
}

/** The keys one memory cites, and those among them that no longer resolve. */
export interface Citations {
  cites: string[];
  staleRefs: MemoryStaleRef[];
}

/** For each text, the keys it cites and the ones among them that no longer resolve: two reads per page. */
export async function resolveCitations(
  projectId: string,
  texts: readonly string[],
): Promise<Citations[]> {
  const reads = memoryIssueReads();
  const prefixes = issuePrefixSet(await reads.issuePrefixes(projectId));
  const cited = texts.map((t) => citedKeys(t, prefixes));
  const [issues, requirements] = await Promise.all([
    reads.issueStandings(
      projectId,
      cited.flatMap((c) => c.issues.map((i) => i.seq)),
    ),
    reads.requirementStatuses(
      projectId,
      cited.flatMap((c) => c.requirements.map((r) => r.seq)),
    ),
  ]);
  return cited.map((c) => ({
    cites: [...c.issues, ...c.requirements].map((k) => k.ref),
    staleRefs: staleRefsOf(c, { issues, requirements }),
  }));
}
