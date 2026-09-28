import { posix } from 'node:path';

export const DECLARATION_VALUES = ['whole-tree'];

/** A declaration line: `@gate-input <value>`, opening a `//` comment or a line of a block comment. */
const DECLARATION_RE = /^[ \t]*(?:\/\/|\/\*\*?|\*)[ \t]*@gate-input\b[ \t]*([^\s*]*)/gm;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

export const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|rs)$/;

/** A run of `'..'` arguments, as `join(here, '..', '..')` spells a climb. */
const DOTDOT_ARGS_RE = /(['"])\.\.\1(?:\s*,\s*(['"])\.\.\2)*/g;

/** A literal opening with `../`, as `resolve(here, '../../..')` or `new URL('../../x', …)` spells one. */
const DOTDOT_LITERAL_RE = /(['"`])((?:\.\.\/)+(?:\.\.)?)/g;

const TOPLEVEL_RE = /rev-parse\s+--show-toplevel/;

/** A call that lists a directory's entries, which is what makes a read a walk. */
export const ENUMERATES_RE =
  /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(|\bls-files\b/;

/** Every declaration the source carries, in order, with the 1-based line each sits on. */
export function declarationsIn(source) {
  const found = [];
  for (const m of source.matchAll(DECLARATION_RE)) {
    const line = source.slice(0, m.index).split('\n').length;
    found.push({ value: m[1], line });
  }
  return found;
}

/** The most directories any one path expression in the source climbs from the file's own. */
export function deepestClimb(source) {
  let most = 0;
  for (const m of source.matchAll(DOTDOT_ARGS_RE)) {
    most = Math.max(most, (m[0].match(/\.\./g) ?? []).length);
  }
  for (const m of source.matchAll(DOTDOT_LITERAL_RE)) {
    most = Math.max(most, (m[2].match(/\.\./g) ?? []).length);
  }
  return most;
}

/**
 * True when a path the source builds reaches the repository root, the one place a walk covers
 * every path. A climb that stops inside `packages/` reads a sibling, which is not this checker's.
 */
export function reachesRoot(file, source) {
  if (TOPLEVEL_RE.test(source)) return true;
  const dir = posix.dirname(file);
  const depth = dir === '.' ? 0 : dir.split('/').length;
  return deepestClimb(source) >= depth;
}

/** Which of `[{ path, source }]` declare a whole-tree input, and each refused, with its remedy. */
export function judgeDeclarations({ files }) {
  const declared = [];
  const refused = [];
  let tests = 0;
  for (const { path, source } of files) {
    const isTest = TEST_FILE_RE.test(path);
    if (isTest) tests++;
    const found = declarationsIn(source);
    if (found.length === 0) {
      if (isTest && reachesRoot(path, source) && ENUMERATES_RE.test(source)) {
        refused.push({
          path,
          why:
            'builds a path to the repository root and lists a directory, so its input is the ' +
            'whole tree and not the paths its job is selected by — add a line `// @gate-input whole-tree` (or ' +
            '` * @gate-input whole-tree` in its opening docblock) so it runs on every change',
        });
      }
      continue;
    }
    const bad = found.filter((d) => !DECLARATION_VALUES.includes(d.value));
    if (bad.length > 0) {
      for (const d of bad) {
        refused.push({
          path,
          why: `line ${d.line} declares \`@gate-input ${d.value || '(nothing)'}\`, and the only valid shape is \`@gate-input ${DECLARATION_VALUES.join(' | ')}\``,
        });
      }
      continue;
    }
    if (!isTest) {
      refused.push({
        path,
        why: `line ${found[0].line} declares a whole-tree input in a file that is not a JavaScript test file, which no vitest configuration can run — move the test into a \`*.test.*\` file`,
      });
      continue;
    }
    declared.push(path);
  }
  return { tests, declared: declared.sort(), refused };
}

/**
 * What a run of the declared files proves: every one collected by some configuration, and every
 * one executing at least one case. `collected` maps a configuration to the declared files it
 * collects; `executed` maps a file to the number of cases that passed or failed in it.
 */
export function judgeRun({ declared, collected, executed }) {
  const reached = new Set(Object.values(collected).flat());
  const refused = [];
  for (const path of declared) {
    if (!reached.has(path)) {
      refused.push({
        path,
        why: 'no vitest configuration collects it, so declaring it runs nothing — bring it into a config’s include list',
      });
    } else if (!(executed[path] > 0)) {
      refused.push({
        path,
        why: 'the run executed no case in it, so a green here would assert nothing — un-skip it or drop the declaration',
      });
    }
  }
  return { refused };
}

/** The declarations half's exit: 1 on a refusal, 2 on an empty scope, 0 otherwise. */
export function declarationExit({ declared, refused }) {
  if (refused.length > 0) return 1;
  return declared.length === 0 ? 2 : 0;
}
