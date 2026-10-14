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

/** Markup with its tags and comments taken out, the text between them kept and joined. */
function withoutTags(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<\/?[A-Za-z][^<>]*>/gu, '');
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
