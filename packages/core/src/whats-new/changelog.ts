/**
 * What's new's source: the CHANGELOG.md of the running build. One `## [version] - date` section
 * per release holds a headline and `###` sections of bullets; a bullet is a bold lead (the title)
 * and the rest (the body). Two HTML comments the release writer leaves (scripts/lib/assemble-release.mjs)
 * are read here: `<!-- tour: <id> -->` closing an entry, and `<!-- digest: <week> -->` opening a
 * bullet under `### Digest`.
 *
 * A section this cannot read is refused by name — file, version, line — and never skipped: the
 * build runs `check-changelog.ts`, and the feed reads through the same function.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOUR_IDS } from '@forge/contracts/tours';
import {
  digestWordCount,
  WHATS_NEW_DIGEST_TITLE_MAX,
  WHATS_NEW_DIGEST_WORDS_MAX,
  WHATS_NEW_SECTIONS,
  type WhatsNewSection,
  weekRange,
} from '@forge/contracts/whats-new';

export interface ChangelogEntry {
  section: WhatsNewSection;
  title: string;
  body: string;
  /** The tour id the entry's fragment named, validated against the catalog. */
  tour: string | null;
}

export interface ChangelogDigest {
  week: string;
  title: string;
  body: string;
}

export interface ChangelogRelease {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  digests: ChangelogDigest[];
  entries: ChangelogEntry[];
}

/** A line of the changelog the reader cannot make sense of, named by file, version and line. */
export interface ChangelogError extends Error {
  file: string;
  version: string | null;
  line: number;
}

function changelogError(
  file: string,
  version: string | null,
  line: number,
  detail: string,
): ChangelogError {
  return Object.assign(new Error(`${file}:${line} ${version ? `[${version}] ` : ''}${detail}`), {
    file,
    version,
    line,
  });
}

/** Whether a thrown value is the refusal `parseChangelog` makes of a section it cannot read. */
export function isChangelogError(err: unknown): err is ChangelogError {
  return err instanceof Error && 'file' in err && 'line' in err && 'version' in err;
}

const RELEASE_HEADING = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/;
const SUBSECTION = /^### (.+?)\s*$/;
const BULLET = /^[-*+] /;
const BOLD_LEAD = /^\*\*(.+?)\*\*\s*(.*)$/s;
const MARKER = /<!--\s*(tour|digest):\s*(\S+?)\s*-->/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const DIGEST_SECTION = 'Digest';

interface RawBullet {
  line: number;
  text: string;
}

/**
 * A bullet's title and body. The fragments the gate admits open with a bold lead; a bullet of the
 * sections written before fragments existed may not, and its first sentence is its title.
 */
function leadOf(clean: string): { title: string; body: string } {
  const lead = BOLD_LEAD.exec(clean);
  if (lead) return { title: (lead[1] as string).trim(), body: (lead[2] as string).trim() };
  const end = /[.;:] |[.;:]$/.exec(clean);
  return end
    ? { title: clean.slice(0, end.index + 1).trim(), body: clean.slice(end.index + 1).trim() }
    : { title: clean, body: '' };
}

const sectionOf = (title: string): WhatsNewSection | typeof DIGEST_SECTION | null =>
  title === DIGEST_SECTION ? DIGEST_SECTION : (WHATS_NEW_SECTIONS.find((s) => s === title) ?? null);

/** Every release of `text`, newest first as written. Throws a `ChangelogError` at the first line it cannot read. */
export function parseChangelog(text: string, file = 'CHANGELOG.md'): ChangelogRelease[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const releases: ChangelogRelease[] = [];
  const seen = new Set<string>();
  let release: ChangelogRelease | null = null;
  let section: WhatsNewSection | typeof DIGEST_SECTION | null = null;
  let bullet: RawBullet | null = null;
  let blankBefore = false;

  const fail = (line: number, detail: string): never => {
    throw changelogError(file, release?.version ?? null, line, detail);
  };

  const flush = () => {
    if (!bullet || !release || !section) return;
    const { line, text: raw } = bullet;
    bullet = null;
    const markers = [...raw.matchAll(MARKER)].map((m) => ({ kind: m[1], value: m[2] as string }));
    const clean = raw.replace(COMMENT, ' ').replace(/\s+/g, ' ').trim();
    const { title, body } = leadOf(clean);
    const digestMark = markers.filter((m) => m.kind === 'digest');
    const tourMark = markers.filter((m) => m.kind === 'tour');
    if (section === DIGEST_SECTION) {
      const week = digestMark[0]?.value;
      if (digestMark.length !== 1 || !week || !weekRange(week)) {
        fail(
          line,
          'a bullet under `### Digest` opens with `<!-- digest: <ISO week> -->`, such as `2026-W41`',
        );
      }
      if (tourMark.length > 0) fail(line, 'a digest cannot offer a tour');
      if (title.length > WHATS_NEW_DIGEST_TITLE_MAX) {
        fail(
          line,
          `a digest title is at most ${WHATS_NEW_DIGEST_TITLE_MAX} characters; this is ${title.length}`,
        );
      }
      if (digestWordCount(body) > WHATS_NEW_DIGEST_WORDS_MAX) {
        fail(
          line,
          `a digest body is at most ${WHATS_NEW_DIGEST_WORDS_MAX} words; this is ${digestWordCount(body)}`,
        );
      }
      release.digests.push({ week: week as string, title, body });
      return;
    }
    if (digestMark.length > 0) fail(line, 'a `digest` marker belongs under `### Digest`');
    if (tourMark.length > 1) fail(line, 'an entry offers at most one tour');
    const tour = tourMark[0]?.value ?? null;
    if (tour !== null && !(TOUR_IDS as readonly string[]).includes(tour)) {
      fail(
        line,
        `tour ${JSON.stringify(tour)} is not in the catalog: it is one of ${TOUR_IDS.join(', ')}`,
      );
    }
    release.entries.push({ section, title, body, tour });
  };

  lines.forEach((text, i) => {
    const at = i + 1;
    const heading = RELEASE_HEADING.exec(text);
    if (heading) {
      flush();
      const version = heading[1] as string;
      const date = heading[2] as string;
      release = { version, date, digests: [], entries: [] };
      section = null;
      blankBefore = false;
      if (seen.has(version)) fail(at, `version ${version} has more than one section`);
      seen.add(version);
      if (
        Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
      ) {
        fail(at, `${date} is not a calendar date`);
      }
      releases.push(release);
      return;
    }
    if (text.startsWith('## ')) {
      fail(
        at,
        `a section heading is \`## [version] - YYYY-MM-DD\`; this is ${JSON.stringify(text)}`,
      );
    }
    if (!release) return;
    const sub = SUBSECTION.exec(text);
    if (sub) {
      flush();
      section = sectionOf(sub[1] as string);
      if (!section) {
        fail(
          at,
          `\`### ${sub[1]}\` is not a section: it is one of ${[...WHATS_NEW_SECTIONS, DIGEST_SECTION].join(', ')}`,
        );
      }
      blankBefore = false;
      return;
    }
    if (/^#{1,6} /.test(text))
      fail(at, `a heading inside a release is \`### Section\`; this is ${JSON.stringify(text)}`);
    if (text.trim() === '') {
      blankBefore = true;
      return;
    }
    if (BULLET.test(text)) {
      flush();
      if (!section) fail(at, 'a bullet sits before any `###` section');
      bullet = { line: at, text: text.slice(2) };
      blankBefore = false;
      return;
    }
    if (!section) return; // the headline of the release
    if (bullet && (!blankBefore || /^\s/.test(text))) {
      bullet.text += ` ${text.trim()}`;
      blankBefore = false;
      return;
    }
    fail(
      at,
      `prose after a blank line reaches no entry: ${JSON.stringify(text.trim().slice(0, 50))}; join it to its bullet or give it a bullet of its own`,
    );
  });
  flush();
  return releases;
}

/** The directory upward from this module that holds `CHANGELOG.md`: the repository root, or the app root of the image. */
export function changelogPath(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'CHANGELOG.md');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) {
      throw new Error(
        `no CHANGELOG.md in ${from} or any directory above it: What's new reads the running build's changelog, which the image ships beside dist/`,
      );
    }
    dir = up;
  }
}

let loaded: ChangelogRelease[] | null = null;

/** The running build's releases, read and parsed once. */
export function loadChangelog(): ChangelogRelease[] {
  if (!loaded) {
    const path = changelogPath();
    loaded = parseChangelog(readFileSync(path, 'utf8'), 'CHANGELOG.md');
  }
  return loaded;
}
