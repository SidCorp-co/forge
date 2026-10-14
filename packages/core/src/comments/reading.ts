import type { Nodes, Parents } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const PARSER = unified().use(remarkParse);

/** Nodes whose children sit on one line of the page; the children of any other node each take a line. */
const PHRASING = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'inlineCode',
  'break',
  'html',
  'footnoteReference',
]);

/** Whether a tag opens at `at`: `<` then a letter, or `<`, `/` and a letter. */
function opensTag(html: string, at: number): boolean {
  if (html[at] !== '<') return false;
  const next = html[at + 1] ?? '';
  const name = next === '/' ? (html[at + 2] ?? '') : next;
  return name.toLowerCase() !== name.toUpperCase() && name < '\u0080';
}

/**
 * The text of markup, read once from the front the way a browser reads it: a tag runs to the first
 * `>`, a comment to `-->`, and a `<!` that opens no comment to the first `>`. What a pass leaves is
 * never read again for tags, so pieces cannot be rejoined into a tag by what was taken out. A tag
 * or comment that is never closed stays as the text it is.
 */
function withoutTags(html: string): string {
  let text = '';
  let at = 0;
  while (at < html.length) {
    const closer = html.startsWith('<!--', at)
      ? '-->'
      : html.startsWith('<!', at) || html.startsWith('<?', at) || opensTag(html, at)
        ? '>'
        : null;
    const end = closer === null ? -1 : html.indexOf(closer, at + 2);
    if (closer === null || end < 0) {
      text += html[at];
      at += 1;
    } else {
      at = end + closer.length;
    }
  }
  return text;
}

function textOf(node: Nodes, depth: number): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return node.value;
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'break':
      return '\n';
    case 'html': {
      const bare = withoutTags(node.value);
      return depth < 3 && bare.trim() !== '' ? readAsText(bare, depth + 1) : bare;
    }
    default:
      break;
  }
  const children = (node as Parents).children;
  if (!Array.isArray(children)) return '';
  const parts = children.map((child) => textOf(child, depth));
  return children.some((child) => PHRASING.has(child.type)) ? parts.join('') : parts.join('\n');
}

/**
 * The text a reader of the comment sees once markdown is drawn: emphasis markers, link syntax,
 * escapes and character references resolved, and tags that wrap nothing gone. A stored value split
 * by `**`, `&#97;` or `<b></b>` is whole again here, which a literal match on the body never sees.
 */
export function readAsText(body: string, depth = 0): string {
  return textOf(PARSER.parse(body) as Nodes, depth);
}
