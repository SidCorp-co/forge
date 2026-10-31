/**
 * ISS-845 (owner, 2026-10-31, REQ-79 r6) — a pass judged at an earlier commit counts at a later
 * landing that descends from it: a fix round landing again no longer voids every pass the round
 * before it earned (adminhub-api ISS-78 lost 237 of 452 that way when its round 11 changed two
 * files). It is reported as carried, naming both commits and the files that changed between them
 * where they were read. A verdict that declares `covers` rests on those path prefixes, and does not
 * carry where a file between the two falls under one, or where what changed between them was not
 * read: an unread answer earns nothing.
 *
 * What the landing holds of the judged commit is a `Carriage` (`issues/weighing.ts`), as the runtime
 * weighing carries a pass to a served commit that descends from it (`issues/runtime-standing.ts`):
 * read from the landings Forge recorded on a read path (`release-batch/landed-build-holds.ts:earlierCarriageOf`),
 * and from the source host by the record door (`release-batch/landing-coverage.ts`). The release
 * hold (`release-batch/landed-weighing.ts`), the record door and a requirement's coverage
 * (`requirements/standing-identity.ts:atLanding`) all read a pass's carriage here.
 */

import { type Carriage, coveredChanges } from './weighing.js';

const short = (sha: string) => sha.slice(0, 12);

const SHOWN_FILES = 3;

/** `n files: a, b, c and m more`, every name in backticks. */
export function filesNamed(files: readonly string[]): string {
  const shown = files.slice(0, SHOWN_FILES).map((f) => `\`${f}\``);
  const more = files.length > SHOWN_FILES ? ` and ${files.length - SHOWN_FILES} more` : '';
  return `${files.length} file${files.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`;
}

/** The answer a carriage gives one pass: carried, refused naming why, unread, or not asked (null). */
export type LandedCarriage =
  | { kind: 'carried'; words: string }
  | { kind: 'refused'; why: string }
  | { kind: 'unread'; why: string };

/**
 * How a pass judged at `judged`, covering `covers`, stands on the landing `build` by what `build`
 * holds of it. Null where nothing was asked about the pair, which says nothing either way.
 */
export function carriedToLanding(
  build: string,
  judged: string,
  covers: readonly string[] | null | undefined,
  carriage: Carriage | undefined,
): LandedCarriage | null {
  if (!carriage) return null;
  const at = `it was judged at \`${short(judged)}\``;
  if (carriage.kind === 'unread') {
    return {
      kind: 'unread',
      why: `${at}, not at \`${short(build)}\`, and whether \`${short(build)}\` descends from it was not read: ${carriage.why}`,
    };
  }
  if (carriage.kind !== 'descends') {
    const said = carriage.kind === 'lacks' ? ` (${carriage.why})` : '';
    return {
      kind: 'refused',
      why: `${at}, which \`${short(build)}\` does not descend from${said}, so it judged another build`,
    };
  }
  const by = carriage.by ? ` (${carriage.by})` : '';
  const paths = carriage.paths;
  const named = covers && covers.length > 0 ? covers.map((c) => `\`${c}\``).join(', ') : null;
  if (named && paths === undefined) {
    return {
      kind: 'refused',
      why: `${at}, which \`${short(build)}\` descends from${by}, and it covers ${named}: what changed between them was not read, so whether that still holds is unknown`,
    };
  }
  const hit = coveredChanges(covers, paths ?? []);
  if (hit.length > 0) {
    return {
      kind: 'refused',
      why: `${at}, and \`${short(build)}\` changes ${filesNamed(hit)} since then, under what it covers (${named})`,
    };
  }
  const between =
    paths === undefined
      ? 'what changed between them was not read'
      : paths.length === 0
        ? 'no file changed between them'
        : `${filesNamed(paths)} changed between them`;
  return {
    kind: 'carried',
    words: `carried from \`${short(judged)}\` to \`${short(build)}\`, which descends from it${by}; ${between}`,
  };
}
