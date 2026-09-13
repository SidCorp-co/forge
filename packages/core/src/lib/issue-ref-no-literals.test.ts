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
 * Sites where the CANONICAL `ISS-` form is deliberate, because the value is a storage key matched
 * by string containment rather than a reference anybody reads. Each one carries a `cm:guard`
 * saying so; this list is the second half of that pair.
 */
const CANONICAL_SITES = [
  'devices/admissible.ts',
  'devices/run-session.ts',
  'devices/run-issue-return.ts',
];

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

/** Every way this repo knows of to assemble a reference by hand, from one line of source. */
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

describe('issue references are built in one place (ISS-992)', () => {
  const files = walk(SRC).filter((f) => {
    const rel = relative(SRC, f);
    return !OWNERS.includes(rel) && !CANONICAL_SITES.includes(rel) && !(rel in NOT_A_REFERENCE);
  });

  it('scans the whole source tree, so an empty result means clean and not unrun', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('finds no hand-built reference outside the module that owns them', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('--')) {
          continue;
        }
        for (const hit of handBuiltReferencesIn(line)) {
          offenders.push(`${rel}:${i + 1} — ${hit.slice(0, 100)}`);
        }
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
