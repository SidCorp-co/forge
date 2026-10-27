// The prose a person reads that is not a TypeScript literal: a guide's markdown, and the API
// reference's descriptions. Each is read with its code marks, fenced blocks and link targets taken
// out, since those name values, paths and addresses rather than saying anything (ISS-1421 r40).

/** "Ship" is the team's word for a release, and a person outside the team reads it as a boat. */
export const SHIP = /\bship(s|ped|ping)?\b/i;

const FENCE = /^\s*(```|~~~)/;

/** A paragraph's words as a reader meets them: no code mark, no link target, no tag. */
function uncoded(text: string): string {
  return text
    .replace(/`[^`]*`/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, '');
}

/** Every sentence of `markdown` saying `word` outside a code mark, as `<line>: <sentence>`, the
 *  line being where its paragraph opens. A table's cells are sentences of their own. */
export function proseSaying(markdown: string, word: RegExp): string[] {
  const found: string[] = [];
  let fenced = false;
  let block: string[] = [];
  let opens = 0;
  const flush = () => {
    for (const said of uncoded(block.join(' ')).split(/(?<=[.!?])\s+|\s*\|\s*/)) {
      if (word.test(said)) found.push(`${opens}: ${said.trim()}`);
    }
    block = [];
  };
  markdown.split('\n').forEach((line, at) => {
    if (FENCE.test(line)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (line.trim() === '') {
      flush();
      return;
    }
    if (block.length === 0) opens = at + 1;
    block.push(line.trim());
  });
  flush();
  return found;
}

/** The keys of an OpenAPI document whose value a person reads as prose. */
const READ_KEYS = new Set(['summary', 'description', 'title']);

/** Every described sentence in `document` saying `word`, as `<path>: <sentence>`. */
export function describedSaying(document: unknown, word: RegExp, at = ''): string[] {
  if (Array.isArray(document)) {
    return document.flatMap((item, i) => describedSaying(item, word, `${at}[${i}]`));
  }
  if (!document || typeof document !== 'object') return [];
  return Object.entries(document).flatMap(([key, value]) => {
    const path = `${at}/${key}`;
    if (READ_KEYS.has(key) && typeof value === 'string') {
      return proseSaying(value, word).map((hit) => `${path}:${hit.slice(hit.indexOf(':') + 1)}`);
    }
    return describedSaying(value, word, path);
  });
}
