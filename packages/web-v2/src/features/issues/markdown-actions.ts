// What each toolbar button does to the text, as pure functions.
//
// Kept apart from the editor because this is the whole of the behaviour: a
// CodeMirror view in jsdom renders without layout, so a component test can
// assert a button exists and cannot assert what pressing it wrote. These are
// the assertions that can fail.

export interface Span {
  doc: string;
  from: number;
  to: number;
}

/** A CodeMirror change plus where the caret ends up. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  /** Absolute document offsets to select once applied. */
  selectFrom: number;
  selectTo: number;
}

// cm:guard a marker already around the selection is REMOVED rather than doubled: pressing bold twice must leave the text as it started, and a second pair turns `**x**` into `****x****`, which renders as literal asterisks.
export function toggleWrap(span: Span, marker: string): Edit {
  const { doc, from, to } = span;
  const selected = doc.slice(from, to);
  const n = marker.length;
  const inside = selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= n * 2;
  if (inside) {
    const bare = selected.slice(n, -n);
    return { from, to, insert: bare, selectFrom: from, selectTo: from + bare.length };
  }
  const outside = doc.slice(from - n, from) === marker && doc.slice(to, to + n) === marker;
  if (outside) {
    return {
      from: from - n,
      to: to + n,
      insert: selected,
      selectFrom: from - n,
      selectTo: from - n + selected.length,
    };
  }
  const insert = `${marker}${selected}${marker}`;
  return { from, to, insert, selectFrom: from + n, selectTo: from + n + selected.length };
}

function lineBounds(doc: string, from: number, to: number): { start: number; end: number } {
  const start = doc.lastIndexOf("\n", from - 1) + 1;
  const nl = doc.indexOf("\n", to);
  return { start, end: nl === -1 ? doc.length : nl };
}

// cm:guard the prefix is toggled per SELECTION, not per line: a selection where every line already carries it is un-prefixed, and one where any line lacks it is prefixed throughout. Toggling line by line leaves a half-quoted block that reads as two blocks.
export function togglePrefix(span: Span, prefix: string): Edit {
  const { doc } = span;
  const { start, end } = lineBounds(doc, span.from, span.to);
  const lines = doc.slice(start, end).split("\n");
  const has = (l: string) => l.startsWith(prefix);
  const next = lines.every(has)
    ? lines.map((l) => l.slice(prefix.length))
    : lines.map((l) => (has(l) ? l : `${prefix}${l}`));
  const insert = next.join("\n");
  return { from: start, to: end, insert, selectFrom: start, selectTo: start + insert.length };
}

// cm:guard numbering is rewritten from 1 across the whole selection rather than incremented from whatever was there: markdown renumbers a list by its first item anyway, and preserving stale numbers makes the source disagree with what renders.
export function toggleOrderedList(span: Span): Edit {
  const { doc } = span;
  const { start, end } = lineBounds(doc, span.from, span.to);
  const lines = doc.slice(start, end).split("\n");
  const numbered = /^\d+\.\s/;
  const next = lines.every((l) => numbered.test(l))
    ? lines.map((l) => l.replace(numbered, ""))
    : lines.map((l, i) => `${i + 1}. ${l.replace(numbered, "")}`);
  const insert = next.join("\n");
  return { from: start, to: end, insert, selectFrom: start, selectTo: start + insert.length };
}

/** `[selected](url)`, with the caret left where the url goes when there is none. */
export function makeLink(span: Span): Edit {
  const { doc, from, to } = span;
  const text = doc.slice(from, to) || "text";
  const insert = `[${text}]()`;
  const caret = from + insert.length - 1;
  return { from, to, insert, selectFrom: caret, selectTo: caret };
}

// cm:guard a fence opens on its own line and the blank line before it is written when one is missing: ```` ``` ```` directly after prose is not a fence to any markdown parser, it is three backticks in a paragraph.
export function makeFence(span: Span, info: string): Edit {
  const { doc, from, to } = span;
  const selected = doc.slice(from, to);
  const lead = from === 0 || doc[from - 1] === "\n" ? "" : "\n";
  const insert = `${lead}\`\`\`${info}\n${selected}\n\`\`\`\n`;
  const caret = from + lead.length + 3 + info.length + 1;
  return { from, to, insert, selectFrom: caret, selectTo: caret + selected.length };
}

// cm:guard the heading cycles 1 -> 2 -> 3 -> none and never appends: `#` on a line that already carries one produces `##` by concatenation, so a reader pressing it twice silently demotes instead of toggling.
export function cycleHeading(span: Span): Edit {
  const { doc } = span;
  const { start, end } = lineBounds(doc, span.from, span.to);
  const line = doc.slice(start, end);
  const m = /^(#{1,3})\s/.exec(line);
  const bare = m ? line.slice(m[0].length) : line;
  const level = m ? m[1].length : 0;
  const next = level >= 3 ? "" : `${"#".repeat(level + 1)} `;
  const insert = `${next}${bare}`;
  return { from: start, to: end, insert, selectFrom: start + insert.length, selectTo: start + insert.length };
}
