/**
 * `VISION: <name>` citations, read against the principle names `docs/VISION.md` carries.
 *
 * VISION makes the bold kebab-case name of each principle its identifier and forbids citing one
 * by number. A name renamed or removed there leaves every citation of it pointing at nothing, and
 * nothing else reads them, so this is what does. Pure: the gate reads the files, this judges them.
 */

/** The heading of the section the names are read from, numbered or not: `## 4. Principles`. */
const SECTION = /^##[ \t]+(?:\d+\.[ \t]*)?Principles[ \t]*$/m;
/** One principle: a numbered item opening on its bold kebab-case name. */
const ITEM = /^[ \t]*\d+\.[ \t]+\*\*([a-z0-9]+(?:-[a-z0-9]+)*)\*\*/gm;

/**
 * The principle names VISION carries, or the reason none could be read. Never an empty list: a
 * section that moved or a format that changed would otherwise pass every citation as unknown-free
 * only because there was nothing to compare against — the parser refuses instead.
 */
export function principlesOf(vision) {
  const head = SECTION.exec(vision);
  if (!head) return { error: 'has no `## Principles` section (a `## <n>. Principles` heading)' };
  const after = vision.slice(head.index + head[0].length);
  const end = after.search(/^##[ \t]/m);
  const body = end === -1 ? after : after.slice(0, end);
  const names = [...body.matchAll(ITEM)].map((m) => m[1]);
  if (names.length === 0) {
    return {
      error:
        'has a Principles section that yields no names (each is a numbered item opening `**kebab-name**`)',
    };
  }
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0)
    return { error: `names ${twice.join(', ')} twice in its Principles section` };
  return { names };
}

// Not preceded by a word, a dot, a slash or a hyphen, so `docs/VISION.md:sym` and `MY_VISION:` are
// not read as a citation. After the colon, a citation wrapped onto the next comment line still
// reads as one: `(VISION:` / `// state-never-lies)` is how most code comments here carry it.
const LEAD = String.raw`(?<![\w./-])VISION`;
const WRAP = String.raw`[ \t]*(?:\r?\n[ \t]*(?:\/\/\/?|\*|--|#)?[ \t]*)?`;
const BY_NAME = new RegExp(`${LEAD}:${WRAP}\`?([A-Za-z0-9][A-Za-z0-9_-]*)`, 'g');
const BY_NUMBER = new RegExp(String.raw`${LEAD}(?:\.md)?:?[ \t]*([№§#])[ \t]*(\d+)`, 'g');

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every VISION citation in one file, by name or by number, with the line it starts on. */
export function visionCitationsIn(rel, text) {
  if (!text.includes('VISION')) return [];
  const out = [];
  for (const m of text.matchAll(BY_NAME)) {
    out.push({ rel, line: lineOf(text, m.index), token: `VISION: ${m[1]}`, name: m[1] });
  }
  for (const m of text.matchAll(BY_NUMBER)) {
    out.push({ rel, line: lineOf(text, m.index), token: `VISION ${m[1]}${m[2]}`, name: null });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The two that fail: a name VISION does not carry, and any citation by number. */
export function judgeVision(citations, names) {
  const known = new Set(names);
  const unknown = [];
  const byNumber = [];
  for (const c of citations) {
    if (c.name === null) byNumber.push(c);
    else if (!known.has(c.name)) unknown.push(c);
  }
  return { unknown, byNumber };
}
