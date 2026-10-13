// The order a tag-gated refusal names "newest" by: semver precedence where a tag is a version, and
// the numeric-aware text order for the rest. It never decides which tags count; the pattern does.
//
// `semver` is not a declared dependency of this package, and a tag the pattern names need not be a
// version (`*` matches `nightly-2026-10-9`), where a semver parser would refuse it or lose it.

const text = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

/** Digit strings compared as numbers of any length. */
function digits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  return x.length === y.length ? (x < y ? -1 : x > y ? 1 : 0) : x.length - y.length;
}

/** Where a tag stands in its own prefix and numeric core: a prerelease, the plain version, or the version with something else after it. */
type Rank = 0 | 1 | 2;

interface Version {
  prefix: string;
  core: string[];
  rank: Rank;
  /** The prerelease identifiers (rank 0) or the whole remainder (rank 2). */
  rest: string[];
}

const SEMVER_PRERELEASE = /^-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z.-]+)?$/;

function read(tag: string): Version {
  const at = tag.search(/\d/);
  if (at < 0) return { prefix: tag, core: [], rank: 1, rest: [] };
  const run = /^\d+(?:\.\d+)*/.exec(tag.slice(at));
  const core = run ? run[0] : '';
  const after = tag.slice(at + core.length);
  const segments = core.split('.');
  if (after === '') return { prefix: tag.slice(0, at), core: segments, rank: 1, rest: [] };
  const pre = segments.length >= 2 ? SEMVER_PRERELEASE.exec(after) : null;
  return pre?.[1]
    ? { prefix: tag.slice(0, at), core: segments, rank: 0, rest: pre[1].split('.') }
    : { prefix: tag.slice(0, at), core: segments, rank: 2, rest: [after] };
}

function identifiers(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] as string;
    const y = b[i] as string;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const d = digits(x, y);
      if (d !== 0) return d;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** Ascending order of two tags: negative where `a` is the older. */
export function compareTags(a: string, b: string): number {
  const x = read(a);
  const y = read(b);
  const prefix = text(x.prefix, y.prefix);
  if (prefix !== 0) return prefix;
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const l = x.core[i];
    const r = y.core[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const d = digits(l, r);
    if (d !== 0) return d;
  }
  if (x.rank !== y.rank) return x.rank - y.rank;
  return x.rank === 0 ? identifiers(x.rest, y.rest) : text(x.rest.join(''), y.rest.join(''));
}
