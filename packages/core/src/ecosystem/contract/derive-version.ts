import { type MeasuredDiff, notMeasured } from './diff.js';
import { measureChange } from './measure.js';
import { compareVersions, parseVersion, proposeVersion } from './naming.js';

/** What a contract held before anything numbered it; the first number after it is 1.0.0. */
export const UNNUMBERED = 'unversioned';

type Measure = (type: string, previous: string, next: string) => Promise<MeasuredDiff>;

export type DerivedVersion =
  | { ok: true; version: string; why: string }
  | { ok: false; refusal: string };

const listed = (diff: MeasuredDiff) =>
  diff.changes
    .slice(0, 3)
    .map((c) => `${c.element}: ${c.text}`)
    .join('; ');

type Text = { version: string | null; text: string };
type Input = { type: 'openapi' | 'mcp-tools'; base: Text; next: string; floor?: Text | null };

/**
 * The semver number a generated contract takes after `base`, by the rule a version uploaded to an
 * interface is held to (`naming.ts:proposeVersion`): breaking owes a MAJOR, an addition a MINOR,
 * anything else a PATCH. The two texts are compared with their own version field set alike, so the
 * number moves only when the contract does.
 *
 * Where the upload rule leaves the number to its uploader, this is that uploader and it never
 * guesses low: a change measured unknown takes a MAJOR, since no differ called it safe to take
 * under a caret pin. A change no differ measured is refused, naming why, never numbered.
 *
 * `floor` is the latest version the interface registry already holds and the text it was uploaded
 * from. The registry refuses any number not after it, so the number is at least the one the change
 * since the floor owes, and strictly after the floor even where nothing changed: a number the
 * registry holds, approved or not, is never taken again.
 */
export async function deriveVersion(
  input: Input,
  measure: Measure = measureChange,
): Promise<DerivedVersion> {
  const derived = await after(input.type, input.base, input.next, measure);
  const floor = input.floor;
  if (!derived.ok || !floor) return derived;
  const f = floor.version === null ? null : parseVersion('semver', floor.version);
  if (!f) {
    return {
      ok: false,
      refusal: `the registry floor is "${floor.version}", which is not MAJOR.MINOR.PATCH, so no number can follow it`,
    };
  }
  // no change since the floor can owe more than its next MAJOR, so a number there or past it stands
  if (compareVersions('semver', derived.version, `${f[0] + 1}.0.0`) >= 0) return derived;
  const over = await after(input.type, floor, input.next, measure);
  if (!over.ok) return over;
  const next =
    over.version === floor.version
      ? { version: `${f[0]}.${f[1]}.${f[2] + 1}`, why: `unchanged since ${floor.version}` }
      : over;
  if (compareVersions('semver', next.version, derived.version) <= 0) return derived;
  return {
    ok: true,
    version: next.version,
    why: `after the registry floor ${floor.version}, which this contract has not yet passed: ${next.why}`,
  };
}

async function after(
  type: Input['type'],
  base: Text,
  next: string,
  measure: Measure,
): Promise<DerivedVersion> {
  if (base.version === null || base.version === UNNUMBERED) {
    return { ok: true, version: '1.0.0', why: 'the first number this contract takes' };
  }
  const p = parseVersion('semver', base.version);
  if (!p) {
    return {
      ok: false,
      refusal: `the base contract is numbered "${base.version}", which is not MAJOR.MINOR.PATCH, so no number can follow it`,
    };
  }
  if (base.text === next) return { ok: true, version: base.version, why: 'unchanged' };
  const diff = await measure(type, base.text, next);
  const why = notMeasured(diff);
  if (why.length > 0) {
    return {
      ok: false,
      refusal: `no differ measured the change since ${base.version} (${why.map((c) => c.text).join('; ')}), so no number can be derived from it`,
    };
  }
  const n = diff.changes.length;
  if (diff.classification === 'unknown') {
    return {
      ok: true,
      version: `${p[0] + 1}.0.0`,
      why: `measured unknown after ${base.version}, which takes a MAJOR (${n} change(s): ${listed(diff)})`,
    };
  }
  return {
    ok: true,
    version: proposeVersion('semver', base.version, diff, ''),
    why: `measured ${diff.classification} after ${base.version} (${n} change(s)${n > 0 ? `: ${listed(diff)}` : ''})`,
  };
}
