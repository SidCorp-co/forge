import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ISS-992 — a reference is built in one place or the feature is a lie.
 *
 * A project set to `FD` whose alarms still say `ISS-977` has reintroduced exactly the ambiguity
 * the prefix removes, and nothing else in the suite notices: every emit site has its own test, and
 * every one of them passes against a project with no prefix. This scan is what makes the claim
 * checkable across all of them at once.
 *
 * It is a syntactic scan standing for a semantic rule, so it names the forms it refuses rather
 * than pretending to catch every way a reference could be assembled: the template literal, the
 * concatenation, and the `join` over a separator (codex review, 2026-09-13).
 */

const SRC = new URL('..', import.meta.url).pathname;

// cm:why The two files that are allowed to name the prefix: the module that owns formatting, and its own tests. Everything else asks one of them.
const OWNERS = ['lib/issue-ref.ts', 'lib/issue-ref.test.ts'];

/**
 * The marker a CANONICAL `ISS-` expression carries: a storage key matched by string containment,
 * not a reference anybody reads. It exempts the EXPRESSION and never the file, because the line
 * between storage and presentation runs per expression — a file holding a canonical key may still
 * gain a user-facing reference, and exempting it whole is how that one would land unseen (codex
 * review of ISS-992).
 */
const CANONICAL_MARK = 'ISS-992:canonical';

/**
 * Sites that name the shape for a reason that is not an issue reference at all. Each needs a
 * sentence, because "it was already there" is how an exemption list becomes a second baseline.
 */
const NOT_A_REFERENCE = {
  // cm:why The git branch convention is `iss-<seq>-<slug>`, a different namespace from the reference: renaming branches would break salvage matching, live worktrees and every merged branch's history, and ISS-992 put none of that in scope.
  'issues/metadata.ts': 'the git branch convention, not an issue reference',
  // cm:why This file's own mutation fixtures ARE hand-built references; that is what they are for.
  'lib/issue-ref-no-literals.test.ts': 'the mutation fixtures this scan is made of',
};

const TEMPLATE = /`[^`]*\$\{[^}]*\}[^`]*`/g;
// cm:guard a hand-built reference is read over a WINDOW of lines and never one line at a time — `[prefix, seq]` and `.join('-')` on separate lines is the same defect written by a formatter, and a line-at-a-time scan is green on it (codex review of ISS-992)
const WINDOW = 3;
const SEQ_BEARING = /iss[_ ]?seq/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Every way this repo knows of to assemble a reference by hand, from a span of source. */
function handBuiltReferencesIn(line: string): string[] {
  const found: string[] = [];
  for (const lit of line.match(TEMPLATE) ?? []) {
    if (/ISS-\$\{/.test(lit) || (/-\$\{/.test(lit) && SEQ_BEARING.test(lit))) found.push(lit);
  }
  // cm:why `'ISS-' + seq`, `'ISS-' || iss_seq`, and the SQL concatenation
  if (/['"]ISS-['"]\s*(?:\+|\|\|)/.test(line)) found.push(line.trim());
  // cm:why `[prefix, seq].join('-')` and `[prefix, seq].join("-")`
  if (/\.join\(\s*['"]-['"]\s*\)/.test(line) && SEQ_BEARING.test(line)) found.push(line.trim());
  return found;
}

/** Comment lines are blanked rather than dropped, so a window never joins prose to code. */
function offendersIn(source: string): string[] {
  const lines = source.split('\n').map((line) => {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('--') ? '' : line;
  });
  const found = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const span = lines.slice(i, i + WINDOW);
    if (span.some((l) => l.includes(CANONICAL_MARK))) continue;
    for (const hit of handBuiltReferencesIn(span.join(' '))) found.add(hit.trim());
  }
  return [...found];
}

describe('issue references are built in one place (ISS-992)', () => {
  const files = walk(SRC).filter((f) => {
    const rel = relative(SRC, f);
    return !OWNERS.includes(rel) && !(rel in NOT_A_REFERENCE);
  });

  it('scans the whole source tree, so an empty result means clean and not unrun', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('finds no hand-built reference outside the module that owns them', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      for (const hit of offendersIn(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel} — ${hit.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // cm:why The mutation cases. Each is a way somebody could put a reference back by hand; the scanner going green on any of them is the scanner failing, not the code passing.
  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS the forbidden shape — a real template literal here would interpolate and the scanner would never see it
    ['a template literal', 'const ref = `ISS-${row.issSeq}`;'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS the forbidden shape — a real template literal here would interpolate and the scanner would never see it
    ['a template literal under another prefix', 'const ref = `${prefix}-${row.issSeq}`;'],
    ['a string concatenation', "const ref = 'ISS-' + row.issSeq;"],
    ['a SQL concatenation', "sql`'ISS-' || i.iss_seq`"],
    ['a join over a separator', "const ref = [prefix, row.issSeq].join('-');"],
    ['a join with double quotes', 'const ref = [prefix, row.issSeq].join("-");'],
  ])('refuses %s', (_name, line) => {
    expect(handBuiltReferencesIn(line)).not.toEqual([]);
  });

  // cm:why The same three forms a formatter has broken across lines — the defect a line-at-a-time scan cannot see.
  it.each([
    ['a join wrapped onto the next line', "const ref = [prefix, row.issSeq]\n  .join('-');"],
    ['a concatenation wrapped onto the next line', "const ref =\n  'ISS-' + row.issSeq;"],
  ])('refuses %s', (_name, span) => {
    expect(offendersIn(span)).not.toEqual([]);
  });

  it('exempts a canonical expression by its marker, and only within its window', () => {
    const canonical = "const key = 'ISS-' + issue.issSeq; // ISS-992:canonical the run key";
    expect(offendersIn(canonical)).toEqual([]);
    const both = `${canonical}\n\n\n\nconst ref = 'ISS-' + issue.issSeq;`;
    expect(offendersIn(both)).not.toEqual([]);
  });

  it.each([
    ['the approved formatter', 'const ref = formatIssueRef(prefix, row.issSeq);'],
    ['the canonical helper', 'const key = canonicalIssueKey(issue.issSeq);'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS the forbidden shape — a real template literal here would interpolate and the scanner would never see it
    ['an unrelated template literal', 'const label = `${row.type} failed`;'],
    ['an unrelated join', "const names = parts.join('-');"],
  ])('leaves %s alone', (_name, line) => {
    expect(handBuiltReferencesIn(line)).toEqual([]);
  });
});
