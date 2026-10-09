// The pattern catalog's verdict (REQ-36 BC-3, BC-4): one page per pattern under the catalog
// directory, each naming its change kind, the issue that introduced it, and the three parts a build
// and a review read — a reference, a test shape and a review checklist — and the catalog core reads,
// generated from those pages. Pure: the CLI (`scripts/check-pattern-catalog.mjs`) reads the tree.

import { withoutComments, withoutFences } from './markdown.mjs';

/** A page's slug is its file name: what an issue names when it takes the pattern. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const INDEX = 'README.md';

const TITLE_RE = /^#\s+(.+?)\s*$/m;
const KIND_RE = /^\*\*Change kind:\*\*\s*(.+?)\s*$/m;
const INTRODUCED_RE = /^\*\*Introduced by:\*\*\s*([A-Z][A-Z0-9]*-\d+)\b/m;

/** A backticked token that names a file or a directory of this repository, an optional `:symbol` after it. */
const PATH_TOKEN_RE =
  /`([A-Za-z0-9_.@[\]()-]+(?:\/[A-Za-z0-9_.@[\]()-]+)+\/?)(?::[A-Za-z0-9_.$]+)?`/g;

/** A test file in every runner this repo has: vitest's `.test.*`, a `tests/` tree, a Rust `*tests.rs`. */
export function isTestPath(path) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(path) || /(^|\/)tests\//.test(path) || /tests\.rs$/.test(path)
  );
}

/** The pages of the catalog: every `.md` in its directory but the index. */
export function selectPages(names) {
  return names.filter((n) => n.endsWith('.md') && n !== INDEX).sort();
}

/** The lines of the `## <name>` section, up to the next heading of level 2 or higher. */
export function sectionLines(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== '');
}

/**
 * A token is read as a path when it ends in `/` (a directory) or its last segment has an extension,
 * as check-doc-citations reads one: `@forge/contracts` is a package and `packages/runner` names no
 * file, so neither is a claim this checker can hold.
 */
const isPathToken = (t) => t.endsWith('/') || /\.[A-Za-z0-9]+$/.test(t.split('/').pop());

function pathsIn(lines) {
  const out = [];
  for (const line of lines) {
    for (const m of line.matchAll(PATH_TOKEN_RE)) if (isPathToken(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Whether `path` is a tracked file, or a directory (written with its trailing `/`) holding one. */
function present(path, tracked) {
  if (path.endsWith('/')) {
    for (const f of tracked) if (f.startsWith(path)) return true;
    return false;
  }
  return tracked.has(path);
}

const checklistItem = (line) => /^\s*\d+\.\s+\S/.test(line);
const checklistText = (line) => line.replace(/^\s*\d+\.\s+/, '').trim();

/**
 * One page read into its entry, and every rule it breaks, each naming its rule, the page and what a
 * valid page holds instead. `tracked` is the repository's tracked files.
 */
export function judgePage(rel, raw, tracked) {
  const slug = rel.split('/').pop().replace(/\.md$/, '');
  const text = withoutComments(withoutFences(raw));
  const faults = [];
  const fault = (rule, detail) => faults.push(`${rel}: ${rule}: ${detail}`);

  if (!SLUG_RE.test(slug)) {
    fault(
      'PATTERN_SLUG_INVALID',
      `the file name is the slug an issue names, and \`${slug}\` is not one: lower-case letters, digits and hyphens, 2 to 63 characters`,
    );
  }
  const title = TITLE_RE.exec(text)?.[1] ?? null;
  const changeKind = KIND_RE.exec(text)?.[1] ?? null;
  const introducedBy = INTRODUCED_RE.exec(text)?.[1] ?? null;
  if (!title) fault('PATTERN_HEADER_MISSING', 'no `# <Title>` heading opens the page');
  if (!changeKind) {
    fault('PATTERN_HEADER_MISSING', 'no `**Change kind:** <kind>` line names the change it builds');
  }
  if (!introducedBy) {
    fault(
      'PATTERN_HEADER_MISSING',
      'no `**Introduced by:** <ISSUE-n>` line names the issue whose change landed this entry, so its approval cannot be traced',
    );
  }

  const reference = sectionLines(text, 'Reference');
  const references = reference ? pathsIn(reference) : [];
  if (references.length === 0) {
    fault(
      'PATTERN_REFERENCE_MISSING',
      `${reference ? 'the `## Reference` section names no file' : 'no `## Reference` section'}: name at least one tracked file, in backticks from the repository root, that a new change copies`,
    );
  }
  for (const p of references.filter((p) => !present(p, tracked))) {
    fault(
      'PATTERN_REFERENCE_NOT_FOUND',
      `\`${p}\` is named as a reference and no tracked file is there`,
    );
  }

  const testShape = sectionLines(text, 'Test shape');
  const testPaths = testShape ? pathsIn(testShape) : [];
  const tests = testPaths.filter(isTestPath);
  if (tests.length === 0) {
    fault(
      'PATTERN_TEST_SHAPE_MISSING',
      `${testShape ? 'the `## Test shape` section names no test file' : 'no `## Test shape` section'}: name at least one tracked reference test (a \`.test.\` file, a file under \`tests/\`, or a Rust \`*tests.rs\`) and say what a new one asserts`,
    );
  }
  for (const p of testPaths.filter((p) => !present(p, tracked))) {
    fault(
      'PATTERN_TEST_NOT_FOUND',
      `\`${p}\` is named in the test shape and no tracked file is there`,
    );
  }

  const checklistSection = sectionLines(text, 'Review checklist');
  const checklist = (checklistSection ?? []).filter(checklistItem).map(checklistText);
  if (checklist.length === 0) {
    fault(
      'PATTERN_CHECKLIST_MISSING',
      `${checklistSection ? 'the `## Review checklist` section holds no numbered line' : 'no `## Review checklist` section'}: write the lines a reviewer checks the diff against, numbered \`1.\`, \`2.\`, …`,
    );
  }

  return {
    faults,
    entry: {
      slug,
      title: title ?? '',
      changeKind: changeKind ?? '',
      page: rel,
      introducedBy: introducedBy ?? '',
      reference: references,
      tests,
      checklist,
    },
  };
}

/** The index must link every page, and every page it links must exist. */
export function judgeIndex(indexRel, raw, pageRels) {
  if (raw === null) return [`${indexRel}: PATTERN_INDEX_MISSING: the catalog has no index page`];
  const text = withoutComments(withoutFences(raw));
  const linked = new Set([...text.matchAll(/\]\(\.?\/?([a-z0-9-]+\.md)\)/g)].map((m) => m[1]));
  const names = new Set(pageRels.map((r) => r.split('/').pop()));
  const faults = [];
  for (const n of names) {
    if (!linked.has(n)) {
      faults.push(
        `${indexRel}: PATTERN_NOT_INDEXED: \`${n}\` is a catalog entry the index does not link`,
      );
    }
  }
  for (const n of linked) {
    if (!names.has(n)) {
      faults.push(
        `${indexRel}: PATTERN_INDEX_DANGLING: the index links \`${n}\`, which is no page of the catalog`,
      );
    }
  }
  return faults;
}

const IDENT_KEY = /^(\s*)"([A-Za-z_$][A-Za-z0-9_$]*)":/gm;

/** The catalog core reads, as the TypeScript module the generator writes. Deterministic: pages in slug order. */
export function renderCatalog(entries, sourceDir) {
  const body = JSON.stringify(entries, null, '\t').replace(IDENT_KEY, '$1$2:');
  return [
    `// Generated from ${sourceDir}/*.md by \`node scripts/check-pattern-catalog.mjs --write\`: edit the`,
    '// pages, never this file. `pnpm verify` (check-pattern-catalog) refuses it when it disagrees with them.',
    '',
    'import type { PatternEntry } from "./patterns.js";',
    '',
    '/** The pattern catalog of this repository, one entry per page (REQ-36 BC-4). */',
    `export const PATTERN_CATALOG: readonly PatternEntry[] = ${body};`,
    '',
  ].join('\n');
}

/**
 * The whole verdict. `pages` maps each page's repository path to its text; `kinds` are the change
 * kinds the repository declares a pattern for, each of which must have one; `generated` is the
 * generated module's current text, or null when it is absent.
 */
export function judgeCatalog({ dir, pages, index, tracked, kinds, generated, generatedRel }) {
  const rels = Object.keys(pages).sort();
  if (rels.length === 0)
    return { code: 2, reason: `${dir}: no catalog page found — is the path right?` };
  const violations = [];
  const entries = [];
  for (const rel of rels) {
    const { faults, entry } = judgePage(rel, pages[rel], tracked);
    violations.push(...faults);
    entries.push(entry);
  }
  violations.push(...judgeIndex(`${dir}/${INDEX}`, index, rels));
  const covered = new Set(entries.map((e) => e.changeKind));
  for (const kind of kinds) {
    if (!covered.has(kind)) {
      violations.push(
        `${dir}: PATTERN_KIND_UNCOVERED: no page names \`**Change kind:** ${kind}\`, a change kind this repository declares a pattern for`,
      );
    }
  }
  const expected = renderCatalog(entries, dir);
  if (generated !== expected) {
    violations.push(
      `${generatedRel}: PATTERN_CATALOG_STALE: ${generated === null ? 'absent' : 'it disagrees with the pages'}; run \`node scripts/check-pattern-catalog.mjs --write\` and commit what it writes`,
    );
  }
  return {
    code: violations.length > 0 ? 1 : 0,
    scanned: rels.length,
    violations,
    entries,
    expected,
  };
}
