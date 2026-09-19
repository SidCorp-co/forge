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

export function makeFence(span: Span, info: string): Edit {
  const { doc, from, to } = span;
  const selected = doc.slice(from, to);
  const lead = from === 0 || doc[from - 1] === "\n" ? "" : "\n";
  const insert = `${lead}\`\`\`${info}\n${selected}\n\`\`\`\n`;
  const caret = from + lead.length + 3 + info.length + 1;
  return { from, to, insert, selectFrom: caret, selectTo: caret + selected.length };
}

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
