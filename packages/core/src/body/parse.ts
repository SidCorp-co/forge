/**
 * A strict scanner for component bodies — refuses what it cannot read rather
 * than repairing it.
 *
 * This is deliberately NOT an HTML5 parser. The proposal named parse5 and the
 * error message is why it is not used: parse5 repairs. Given
 * `<forge-review><p>x</forge-review>` it relocates the `<p>` and reports
 * nothing, so the 400 that names the mis-nested slot cannot exist. Over a
 * closed tag set with one nesting level, strict rejection is the product and
 * spec-compliant repair is the thing to avoid.
 *
 * The price, stated: no implicit close, no foster parenting, and ~250 lines of
 * scanner this repo owns. A human writing prose never pays it — text with no
 * tags at all is valid input (Decision 3) and never reaches the tag branch.
 */

import { BodyInvalidError } from './errors.js';
import { VOID_TAGS } from './plain-tags.js';

export type BodyAttrs = Record<string, string>;

export type BodyNode =
  | { type: 'text'; value: string; raw?: boolean }
  | { type: 'comment' }
  | { type: 'element'; name: string; attrs: BodyAttrs; children: BodyNode[] };

/**
 * Elements whose content is never scanned for markup.
 *
 * Decision 6: a mermaid body carries `-->` and `<br/>`, which any markup
 * scanner reads as an end-of-comment and a void tag. Lifting the content out
 * at the opening tag — rather than in a pre-pass with placeholders — is the
 * same guarantee with no placeholder that author text could collide with.
 */
// cm:edge contract -> packages/core/src/body/components.ts — a component listed here must also declare `raw: true`; the two are read by different halves (scanner vs validator) and a body that is raw in one and structured in the other loses its content.
export const RAW_TEXT_ELEMENTS = new Set(['forge-diagram']);

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9-]/;
const WS = /\s/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

class Scanner {
  private i = 0;

  constructor(private readonly src: string) {}

  get done(): boolean {
    return this.i >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.i + offset] ?? '';
  }

  startsWith(token: string): boolean {
    return this.src.startsWith(token, this.i);
  }

  take(count = 1): string {
    const out = this.src.slice(this.i, this.i + count);
    this.i += count;
    return out;
  }

  skipWhile(re: RegExp): void {
    while (!this.done && re.test(this.peek())) this.i += 1;
  }

  readWhile(re: RegExp): string {
    const start = this.i;
    this.skipWhile(re);
    return this.src.slice(start, this.i);
  }

  /** Text up to `token`, consuming it. Throws when `token` never arrives. */
  readUntil(token: string, what: string): string {
    return this.readUntilEither([token], what);
  }

  /** Text up to whichever token arrives first, consuming it. */
  readUntilEither(tokens: readonly string[], what: string): string {
    let at = -1;
    let hit = tokens[0] ?? '';
    for (const token of tokens) {
      const found = this.src.indexOf(token, this.i);
      if (found !== -1 && (at === -1 || found < at)) {
        at = found;
        hit = token;
      }
    }
    if (at === -1) {
      throw new BodyInvalidError(
        `unterminated ${what} — no \`${tokens[0]}\` before the end of the body`,
        { expected: tokens[0] },
      );
    }
    const out = this.src.slice(this.i, at);
    this.i = at + hit.length;
    return out;
  }

  /** Line the cursor sits on, 1-indexed — the only position an error quotes. */
  get line(): number {
    let n = 1;
    for (let k = 0; k < this.i && k < this.src.length; k += 1) if (this.src[k] === '\n') n += 1;
    return n;
  }
}

function readAttrs(s: Scanner, tag: string): { attrs: BodyAttrs; selfClosing: boolean } {
  const attrs: BodyAttrs = {};
  for (;;) {
    s.skipWhile(WS);
    if (s.done)
      throw new BodyInvalidError(
        `unterminated tag \`<${tag}>\` — no \`>\` before the end of the body`,
        { element: tag },
      );
    if (s.startsWith('/>')) {
      s.take(2);
      return { attrs, selfClosing: true };
    }
    if (s.peek() === '>') {
      s.take();
      return { attrs, selfClosing: false };
    }
    if (!NAME_START.test(s.peek())) {
      throw new BodyInvalidError(
        `\`<${tag}>\` on line ${s.line}: \`${s.peek()}\` is not a legal attribute name`,
        { element: tag },
      );
    }
    const name = s.readWhile(NAME_CHAR).toLowerCase();
    s.skipWhile(WS);
    if (s.peek() !== '=') {
      // cm:why a bare attribute takes its own name as its value rather than the empty string — `details@open` is the only one the allowlist admits, and an empty value reads as "absent" to every consumer
      attrs[name] = name;
      continue;
    }
    s.take();
    s.skipWhile(WS);
    const quote = s.peek();
    if (quote !== '"' && quote !== "'") {
      throw new BodyInvalidError(
        `\`<${tag} ${name}>\` on line ${s.line}: attribute values must be quoted`,
        { element: tag, attribute: name },
      );
    }
    s.take();
    attrs[name] = decodeEntities(s.readUntil(quote, `attribute \`${name}\` on \`<${tag}>\``));
  }
}

interface Frame {
  name: string;
  attrs: BodyAttrs;
  children: BodyNode[];
}

function pushText(into: BodyNode[], value: string, raw = false): void {
  if (value.length === 0) return;
  const last = into[into.length - 1];
  if (!raw && last && last.type === 'text' && !last.raw) last.value += value;
  else into.push(raw ? { type: 'text', value, raw: true } : { type: 'text', value });
}

/** Source → AST. Throws `BodyInvalidError` on anything it cannot read. */
export function parseBody(src: string): BodyNode[] {
  const s = new Scanner(src);
  const root: BodyNode[] = [];
  const stack: Frame[] = [];
  const top = (): BodyNode[] => stack[stack.length - 1]?.children ?? root;

  while (!s.done) {
    if (s.peek() !== '<') {
      pushText(top(), s.readWhile(/[^<]/));
      continue;
    }
    if (s.startsWith('<!--')) {
      s.take(4);
      s.readUntilEither(['-->', '--!>'], 'HTML comment');
      top().push({ type: 'comment' });
      continue;
    }
    if (s.startsWith('<!')) {
      throw new BodyInvalidError(
        `line ${s.line}: \`<!\` markup (doctype, CDATA) is not allowed in a body`,
      );
    }
    if (s.startsWith('</')) {
      s.take(2);
      const name = s.readWhile(NAME_CHAR).toLowerCase();
      s.skipWhile(WS);
      if (s.peek() !== '>')
        throw new BodyInvalidError(`\`</${name}>\` on line ${s.line} is not terminated`, {
          element: name,
        });
      s.take();
      const frame = stack.pop();
      if (!frame)
        throw new BodyInvalidError(`\`</${name}>\` on line ${s.line} closes nothing`, {
          element: name,
        });
      if (frame.name !== name) {
        throw new BodyInvalidError(
          `\`</${name}>\` on line ${s.line} closes \`<${frame.name}>\` — tags must nest`,
          { element: name, expected: frame.name },
        );
      }
      top().push({
        type: 'element',
        name: frame.name,
        attrs: frame.attrs,
        children: frame.children,
      });
      continue;
    }
    if (!NAME_START.test(s.peek(1))) {
      // cm:why a lone `<` is prose, not a broken tag — Decision 3 makes tag-free text always valid, and `a < b` is what a human writes
      pushText(top(), s.take());
      continue;
    }
    s.take();
    const name = s.readWhile(NAME_CHAR).toLowerCase();
    const { attrs, selfClosing } = readAttrs(s, name);
    if (selfClosing || VOID_TAGS.has(name)) {
      top().push({ type: 'element', name, attrs, children: [] });
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const body = s.readUntil(`</${name}>`, `\`<${name}>\``);
      top().push({
        type: 'element',
        name,
        attrs,
        children: body.length > 0 ? [{ type: 'text', value: body, raw: true }] : [],
      });
      continue;
    }
    stack.push({ name, attrs, children: [] });
  }

  const unclosed = stack.pop();
  if (unclosed)
    throw new BodyInvalidError(`\`<${unclosed.name}>\` is never closed`, {
      element: unclosed.name,
    });
  return root;
}

/** Text a node and its descendants carry, entity-decoded, markup discarded. */
export function textOf(nodes: BodyNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.raw ? n.value : decodeEntities(n.value);
    else if (n.type === 'element') out += textOf(n.children);
  }
  return out;
}
