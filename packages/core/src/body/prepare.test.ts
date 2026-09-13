import { describe, expect, it } from 'vitest';
import { BodyInvalidError } from './errors.js';
import { bodyNodes, prepareBody, resolveFormat } from './prepare.js';

function refusal(raw: string, format: 'html' | undefined = 'html'): BodyInvalidError {
  try {
    prepareBody({ raw, format });
  } catch (err) {
    if (err instanceof BodyInvalidError) return err;
    throw err;
  }
  throw new Error('expected BodyInvalidError, the body was accepted');
}

describe('format resolution', () => {
  it('defaults to markdown, which is what keeps every shipped SKILL.md example valid', () => {
    expect(resolveFormat({ raw: '**Triage** — complexity: m' })).toBe('markdown');
    expect(resolveFormat({ raw: '## Code Review — ISS-898' })).toBe('markdown');
  });

  it('reads a body that opens with a component as html', () => {
    expect(resolveFormat({ raw: '  <forge-blocked on="decision">x</forge-blocked>' })).toBe('html');
  });

  it('passes a markdown body through byte-identically', () => {
    const raw = '## Code Review — ISS-898\n\n- one\n- two\n';
    const out = prepareBody({ raw, format: 'markdown' });
    expect(out.body).toBe(raw);
    expect(out.warnings).toEqual([]);
  });
});

describe('plain markup is repaired and reported, never refused (Decision 3)', () => {
  it('wraps tag-free text in <p> by blank line', () => {
    const out = prepareBody({ raw: 'first line\nstill first\n\nsecond', format: 'html' });
    expect(out.body).toBe('<p>first line\nstill first</p>\n<p>second</p>');
  });

  it('strips a script and its content, and says so', () => {
    const out = prepareBody({ raw: '<p>hi</p><script>alert(1)</script>', format: 'html' });
    expect(out.body).not.toContain('alert');
    expect(out.warnings).toContain('removed `<script>` and its content');
  });

  it('strips event handlers, style and class', () => {
    const out = prepareBody({
      raw: '<p onclick="steal()" style="color:red" class="x">hi</p>',
      format: 'html',
    });
    expect(out.body).toBe('<p>hi</p>');
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        'dropped attribute `onclick` on `<p>`',
        'dropped attribute `style` on `<p>`',
        'dropped attribute `class` on `<p>`',
      ]),
    );
  });

  it('drops a javascript: href but keeps the link text', () => {
    const out = prepareBody({ raw: '<p><a href="javascript:x()">click</a></p>', format: 'html' });
    expect(out.body).toBe('<p><a>click</a></p>');
    expect(out.warnings[0]).toContain('only http, https, relative');
  });

  it('unwraps an unknown tag and keeps the prose', () => {
    const out = prepareBody({ raw: '<div><marquee>hello</marquee></div>', format: 'html' });
    expect(out.body).toBe('<p>hello</p>');
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        'unwrapped unknown tag `<div>`',
        'unwrapped unknown tag `<marquee>`',
      ]),
    );
  });

  it('removes an HTML comment and reports it', () => {
    const out = prepareBody({ raw: '<p>a<!-- hidden -->b</p>', format: 'html' });
    expect(out.body).toBe('<p>ab</p>');
    expect(out.warnings).toContain('removed an HTML comment');
  });

  it('reads a lone < in prose as text', () => {
    expect(prepareBody({ raw: 'a < b and c > d', format: 'html' }).body).toBe(
      '<p>a &lt; b and c &gt; d</p>',
    );
  });
});

describe('bodyNodes — the tree web renders from', () => {
  // cm:guard a STORED component body still parses to a tree, and this is asserted on BYTES rather than through `prepareBody`: writing one is refused from 2026-09-14, so the only way to hold this claim is to hand it the bytes a row already contains.
  it('hands back the parsed tree of a stored component body', () => {
    const stored = '<forge-review sha="60e8d635" verdict="request-changes"></forge-review>';
    const nodes = bodyNodes(stored, 'html');
    expect(nodes?.[0]).toMatchObject({ type: 'element', name: 'forge-review' });
    expect(nodes?.[0]).toHaveProperty('attrs.verdict', 'request-changes');
  });

  it('is null for a markdown body, so the caller renders it as markdown', () => {
    expect(bodyNodes('## Plain\n\n- one', 'markdown')).toBeNull();
  });

  it('sniffs an absent format the same way the other two readers do', () => {
    expect(bodyNodes('<forge-blocked on="decision">x</forge-blocked>', null)).not.toBeNull();
    expect(bodyNodes('a < b is prose', null)).toBeNull();
  });

  // cm:guard the RAW-TEXT lift for `<forge-diagram>` stays in the scanner even though writing one is refused from 2026-09-14: a diagram's content carries `-->` and `<br/>`, so a stored row containing one is unreadable without it — and `bodyNodes` is what draws those rows.
  it('reads a stored raw diagram byte-identically rather than as markup', () => {
    const stored =
      '<forge-diagram kind="mermaid">flowchart TB\n  A --> B\n  B --> C<br/>D</forge-diagram>';
    const child = bodyNodes(stored, 'html')?.[0];
    expect(child).toMatchObject({ type: 'element', name: 'forge-diagram' });
    if (child?.type !== 'element') throw new Error('expected an element');
    expect(child.children).toEqual([
      { type: 'text', value: 'flowchart TB\n  A --> B\n  B --> C<br/>D', raw: true },
    ]);
  });

  it('reads a component this build no longer declares rather than refusing it', () => {
    const nodes = bodyNodes(
      '<forge-from-the-future tone="calm">hi</forge-from-the-future>',
      'html',
    );
    expect(nodes?.[0]).toMatchObject({ type: 'element', name: 'forge-from-the-future' });
    expect(() => prepareBody({ raw: '<forge-from-the-future/>', format: 'html' })).toThrow(
      BodyInvalidError,
    );
  });

  it('degrades to null instead of throwing on bytes it cannot scan', () => {
    expect(bodyNodes('<forge-review sha="60e8d635"', 'html')).toBeNull();
  });

  // cm:edge contract -> packages/core/src/body/parse.ts — `ad14294a` made a non-raw text node hold DECODED characters, so what the web renderer receives is `"` and `&`, not `&quot;` and `&amp;`. React escapes on output; a renderer that unescaped again would double-unescape, and one written against the pre-ad14294a tree would print the entity.
  it('hands the renderer decoded characters, so nothing downstream unescapes twice', () => {
    const raw = '<blockquote><p>a &amp; b, &quot;quoted&quot;, 3 &lt; 4</p></blockquote>';
    const stored = prepareBody({ raw, format: 'html' }).body;
    const root = bodyNodes(stored, 'html')?.[0];
    if (root?.type !== 'element') throw new Error('expected an element');
    const p = root.children[0];
    if (p?.type !== 'element') throw new Error('expected a <p>');
    expect(p.children).toEqual([{ type: 'text', value: 'a & b, "quoted", 3 < 4' }]);
  });

  it('stores the same bytes on a second save of a body carrying entities', () => {
    const raw = '<blockquote><p>a &amp; b</p></blockquote>';
    const once = prepareBody({ raw, format: 'html' }).body;
    expect(prepareBody({ raw: once, format: 'html' }).body).toBe(once);
  });
});

// cm:guard component markup is REFUSED by name and never unwrapped like any other unknown tag: the vocabulary was removed on 2026-09-14, and a caller still emitting `<forge-review>` — a `forge-plugin` skill, over the wire — would otherwise have its structure silently flattened into prose behind a 200.
describe('forge-* markup is refused by name', () => {
  it('names the element and says the set was removed', () => {
    const err = refusal('<forge-review sha="60e8d635" verdict="approve"></forge-review>');
    expect(err.message).toContain('forge-review');
    expect(err.message).toMatch(/removed on 2026-09-14/);
  });

  it('says what to send instead', () => {
    expect(refusal('<forge-plan></forge-plan>').message).toMatch(/markdown, or plain HTML/);
  });

  it('refuses one nested inside plain markup too, rather than unwrapping it', () => {
    expect(() =>
      prepareBody({ raw: '<div><forge-outcome>done</forge-outcome></div>', format: 'html' }),
    ).toThrow(/forge-outcome/);
  });

  // cm:guard a body that merely MENTIONS the name in text is not markup and must stay accepted: refusing on the string rather than on the element would reject every comment discussing the removal.
  it('leaves the name in prose alone', () => {
    const out = prepareBody({ raw: '<p>we removed forge-review</p>', format: 'html' });
    expect(out.body).toContain('we removed forge-review');
  });
});
