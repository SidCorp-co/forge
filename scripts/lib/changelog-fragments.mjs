// An unreleased CHANGELOG entry is a file of its own: one change, one fragment, at a path no other
// branch writes, so a release cutting the version section and a branch adding an entry never edit
// the same lines. The release writer (assemble-release.mjs) folds them into the version section and
// deletes them; the record gate (release-record.mjs) judges their shape.

/** One entry's text with its whitespace collapsed, wherever it lives: a fragment or a CHANGELOG bullet. */
export function normaliseEntry(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Where unreleased entries live, relative to the repository root. */
export const FRAGMENT_DIR = 'changelog.d';

/** The one file in FRAGMENT_DIR that is not a fragment: it says how to write one, and stays. */
export const FRAGMENT_GUIDE = 'README.md';

/** The fragment files among a FRAGMENT_DIR listing. */
export function fragmentFiles(files) {
  return files.filter((f) => (typeof f === 'string' ? f : f.file) !== FRAGMENT_GUIDE);
}

/**
 * The release-note sections, in the order a version section lists them. The same names and order as
 * `releaseNotesSections` in packages/contracts/src/release-notes.ts, less `Skip`, which writes no line.
 */
export const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'];

const SECTION_BY_SUFFIX = new Map(SECTIONS.map((s) => [s.toLowerCase(), s]));

/** `<name>.<section>.md`: the name is the branch or issue that writes it, lower-case kebab. */
const FRAGMENT_NAME = /^([a-z0-9][a-z0-9-]*)\.([a-z]+)\.md$/;

/** The path a writer should use, for a refusal to name. */
export function fragmentPath(name, section = 'fixed') {
  return `${FRAGMENT_DIR}/${name}.${String(section).toLowerCase()}.md`;
}

/** A branch name turned into a fragment name, so a refusal can name the exact path to write. */
export function fragmentNameFor(branch) {
  const name = String(branch ?? '')
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || '<your-branch>';
}

const BOLD_LEAD = /^\*\*[^*\s][^*]*\*\*/;

/**
 * Read one fragment file. `problems` names every way it is not a fragment; an empty list means
 * `entry` (whitespace-normalised, one line) is what the release writer will publish under `section`.
 */
export function readFragment(fileName, text) {
  const problems = [];
  const named = FRAGMENT_NAME.exec(fileName);
  const section = named ? SECTION_BY_SUFFIX.get(named[2]) : undefined;
  if (!named) {
    problems.push(
      `is not named \`<name>.<section>.md\` with a lower-case kebab name (the branch or issue that writes it)`,
    );
  } else if (!section) {
    problems.push(
      `names section \`${named[2]}\`, which is not one of ${[...SECTION_BY_SUFFIX.keys()].map((s) => `\`${s}\``).join(', ')}`,
    );
  }
  const body = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (body === '') problems.push('is empty');
  else {
    if (/\n\s*\n/.test(body)) {
      problems.push(
        'holds more than one paragraph — one change is one entry, and a second change is a second fragment',
      );
    }
    if (/^#{1,6}\s/m.test(body))
      problems.push('holds a heading — the release writer supplies every heading');
    if (/^[-*+]\s/.test(body)) {
      problems.push(
        'opens with a list marker — write the entry text alone; the release writer makes it a bullet',
      );
    } else if (!BOLD_LEAD.test(body)) {
      problems.push(
        'does not open with a bold lead — `**What changed for the reader.**` and then the rest',
      );
    }
  }
  return {
    name: named?.[1] ?? null,
    section: section ?? null,
    entry: normaliseEntry(body),
    problems,
  };
}
