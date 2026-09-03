/**
 * AST → the canonical bytes stored in `body` / `description`.
 *
 * Decision 8 makes the body the single source of truth: there is no blocks
 * column, so whatever this emits is what every reader re-parses. Two
 * properties follow and both are asserted by tests.
 *
 * **Idempotent.** Serializing a body twice yields the same bytes, or a PATCH
 * that changes nothing still rewrites the row.
 *
 * **Raw slots survive byte-identical.** A `forge-diagram` body carries `-->`
 * and `<br/>`, and escaping either would hand the mermaid renderer a diagram
 * it cannot draw (Decision 6).
 */

import type { BodyNode } from './parse.js';
import { VOID_TAGS } from './plain-tags.js';

const BLOCK_TAGS = new Set([
  'p',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'pre',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'details',
  'summary',
  'hr',
]);

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function isBlock(node: BodyNode): boolean {
  if (node.type !== 'element') return false;
  return BLOCK_TAGS.has(node.name) || node.name.startsWith('forge-');
}

function serializeNode(node: BodyNode): string {
  if (node.type === 'comment') return '';
  // cm:guard a `raw` text node is emitted VERBATIM — escaping it turns a mermaid `-->` into `--&gt;` and the diagram stops rendering, which is Decision 6's whole point
  if (node.type === 'text') return node.raw ? node.value : escapeText(node.value);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  if (VOID_TAGS.has(node.name)) return `<${node.name}${attrs} />`;
  return `<${node.name}${attrs}>${node.children.map(serializeNode).join('')}</${node.name}>`;
}

/**
 * Group the loose inline nodes at the top level into `<p>` blocks, split on
 * blank lines. Decision 3: a human types prose and the kernel supplies the
 * markup, so tag-free text is never refused and never stored unwrapped.
 */
function paragraphs(buffer: BodyNode[]): string[] {
  const groups: BodyNode[][] = [[]];
  for (const node of buffer) {
    if (node.type !== 'text' || node.raw) {
      groups[groups.length - 1]?.push(node);
      continue;
    }
    const parts = node.value.split(/\n[ \t]*\n+/);
    parts.forEach((part, i) => {
      if (i > 0) groups.push([]);
      if (part.length > 0) groups[groups.length - 1]?.push({ type: 'text', value: part });
    });
  }
  return groups
    .map((group) => group.map(serializeNode).join('').trim())
    .filter((html) => html.length > 0)
    .map((html) => `<p>${html}</p>`);
}

export function serializeBody(nodes: BodyNode[]): string {
  const out: string[] = [];
  let inline: BodyNode[] = [];
  const flush = () => {
    if (inline.length > 0) out.push(...paragraphs(inline));
    inline = [];
  };
  for (const node of nodes) {
    if (isBlock(node)) {
      flush();
      out.push(serializeNode(node));
      continue;
    }
    inline.push(node);
  }
  flush();
  return out.join('\n');
}
