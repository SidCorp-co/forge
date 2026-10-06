import type { MeasuredDiff } from './diff.js';

export type Versioning = 'dated' | 'semver';

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const DATED = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d{0,5}))?$/;

export const SCHEME_SHAPE: Record<Versioning, string> = {
  semver: 'MAJOR.MINOR.PATCH, e.g. 2.0.0',
  dated: 'YYYY-MM-DD or YYYY-MM-DD.n, e.g. 2026-10-01.2',
};

type Parsed = [number, number, number];

export function parseVersion(versioning: Versioning, v: string): Parsed | null {
  if (versioning === 'semver') {
    const m = SEMVER.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  const m = DATED.exec(v);
  if (!m?.[1] || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return null;
  return [Number(m[1].replace(/-/g, '')), Number(m[2] ?? 0), 0];
}

// a version outside the scheme sorts before every version inside it, so an unparsable builtAgainst is always older and its consumer is always addressed
export function compareVersions(versioning: Versioning, a: string, b: string): number {
  const [x, y] = [parseVersion(versioning, a), parseVersion(versioning, b)];
  if (!x || !y) return x ? 1 : y ? -1 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type Bump = 'major' | 'minor' | 'patch';

// unknown asks for a MAJOR like breaking does: naming a smaller bump would say the change is compatible, which is the one thing an unknown measurement did not show
function bumpOwed(diff: Pick<MeasuredDiff, 'classification' | 'changes'>): Bump {
  if (diff.classification === 'breaking' || diff.classification === 'unknown') return 'major';
  return diff.changes.some((c) => c.kind === 'added') ? 'minor' : 'patch';
}

export function proposeVersion(
  versioning: Versioning,
  previous: string | null,
  diff: Pick<MeasuredDiff, 'classification' | 'changes'>,
  today: string,
): string {
  if (versioning === 'dated') {
    const last = previous ? DATED.exec(previous) : null;
    const day = last?.[1] && last[1] > today ? last[1] : today;
    if (last?.[1] !== day) return day;
    return `${day}.${Number(last[2] ?? 0) + 1}`;
  }
  const p = previous ? parseVersion('semver', previous) : null;
  if (!p) return '1.0.0';
  const bump = bumpOwed(diff);
  if (bump === 'major') return `${p[0] + 1}.0.0`;
  if (bump === 'minor') return `${p[0]}.${p[1] + 1}.0`;
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

export interface NamingProblem {
  code: 'VERSION_NOT_IN_SCHEME' | 'VERSION_BUMP_TOO_SMALL';
  detail: string;
}

export function namingProblem(input: {
  versioning: Versioning;
  previous: string | null;
  requested: string;
  diff: Pick<MeasuredDiff, 'classification' | 'changes'>;
}): NamingProblem | null {
  const { versioning, previous, requested, diff } = input;
  const r = parseVersion(versioning, requested);
  if (!r) {
    return {
      code: 'VERSION_NOT_IN_SCHEME',
      detail: `"${requested}" is not a ${versioning} version; this contract's versions are ${SCHEME_SHAPE[versioning]}.`,
    };
  }
  if (previous === null) return null;
  if (compareVersions(versioning, requested, previous) <= 0) {
    return {
      code: 'VERSION_BUMP_TOO_SMALL',
      detail: `"${requested}" does not come after the latest version "${previous}".`,
    };
  }
  const p = parseVersion(versioning, previous);
  if (versioning !== 'semver' || !p) return null;
  const owed = bumpOwed(diff);
  const short =
    (owed === 'major' && r[0] <= p[0]) || (owed === 'minor' && r[0] === p[0] && r[1] <= p[1]);
  if (!short) return null;
  return {
    code: 'VERSION_BUMP_TOO_SMALL',
    detail: `this change measured ${diff.classification}, which owes a ${owed.toUpperCase()} bump after ${previous}; "${requested}" is smaller, and the next version is ${proposeVersion(versioning, previous, diff, '')}.`,
  };
}
