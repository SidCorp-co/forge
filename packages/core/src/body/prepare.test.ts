import { describe, expect, it } from 'vitest';
import { COMPONENT_NAMES, ROOT_COMPONENT_NAMES, specFor } from './components.js';
import { BodyInvalidError } from './errors.js';
import { RAW_TEXT_ELEMENTS } from './parse.js';
import { bodySlots, bodyText, prepareBody, resolveFormat } from './prepare.js';

const review = (verdict = 'request-changes') => `
<forge-review sha="60e8d635" verdict="${verdict}">
  <forge-finding file="packages/core/src/pipeline/runs-cascade.ts" line="42" severity="bug">
    The cascade skips a <code>held</code> job when the run closes.
  </forge-finding>
  <forge-summary><p>Ran <code>pnpm test:integration</code>; 5 tests red.</p></forge-summary>
</forge-review>`;

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

  it('passes a markdown body through byte-identically, with no template and no slots', () => {
    const raw = '## Code Review — ISS-898\n\n- one\n- two\n';
    const out = prepareBody({ raw, format: 'markdown' });
    expect(out.body).toBe(raw);
    expect(out.template).toBeNull();
    expect(out.slots).toBeNull();
    expect(out.warnings).toEqual([]);
  });
});

describe('a valid component body', () => {
  it('records the template and the parsed slots a downstream reader consumes', () => {
    const out = prepareBody({ raw: review(), format: 'html' });
    expect(out.template).toBe('forge-review');
    expect(out.slots).toMatchObject({
      sha: '60e8d635',
      verdict: 'request-changes',
      findings: [
        {
          file: 'packages/core/src/pipeline/runs-cascade.ts',
          line: '42',
          severity: 'bug',
        },
      ],
    });
    const findings = (out.slots as { findings: Array<{ text: string }> }).findings;
    expect(findings[0]?.text).toContain('skips a held job');
    expect(out.warnings).toEqual([]);
  });

  it('projects to compact text with no markup — the four read paths share this', () => {
    const { text } = prepareBody({ raw: review('approve'), format: 'html' });
    expect(text).toContain('Review 60e8d635: APPROVE · 1 bug');
    expect(text).toContain('runs-cascade.ts:42');
    expect(text).not.toMatch(/<[a-z/]/i);
  });

  it('is idempotent — re-preparing the stored bytes yields the same bytes', () => {
    const once = prepareBody({ raw: review(), format: 'html' });
    const twice = prepareBody({ raw: once.body, format: 'html' });
    expect(twice.body).toBe(once.body);
  });

  it('reads slots and text back off the stored row', () => {
    const { body } = prepareBody({ raw: review(), format: 'html' });
    expect(bodySlots(body, 'html')).toMatchObject({ verdict: 'request-changes' });
    expect(bodyText(body, 'html')).toContain('REQUEST-CHANGES');
    expect(bodySlots(body, 'markdown')).toBeNull();
    expect(bodyText(body, 'markdown')).toBe(body);
  });
});

describe('an invalid forge-* body is refused, and the message names the offender', () => {
  it('names the attribute AND its legal set', () => {
    const err = refusal(review('approved'));
    expect(err.code).toBe('BODY_INVALID');
    expect(err.message).toContain('forge-review@verdict');
    expect(err.message).toContain('approve|request-changes|abstain');
    expect(err.message).toContain('approved');
  });

  it('names a missing required slot', () => {
    const err = refusal('<forge-review sha="60e8d635" verdict="approve">ok</forge-review>');
    expect(err.message).toContain('forge-review');
    expect(err.message).toContain('forge-summary');
    expect(err.message).toMatch(/required slot/);
  });

  it('names an attribute the schema does not declare', () => {
    const err = refusal('<forge-blocked on="decision" mood="grim">x</forge-blocked>');
    expect(err.message).toContain('forge-blocked');
    expect(err.message).toContain('mood');
  });

  it('names an unregistered component and lists the roots', () => {
    const err = refusal('<forge-nonsense>x</forge-nonsense>');
    expect(err.message).toContain('forge-nonsense');
    expect(err.message).toContain('forge-review');
  });

  it('names both sides when a slot sits under a parent that does not declare it', () => {
    const err = refusal(
      '<forge-blocked on="decision"><forge-finding file="a.ts" severity="bug">x</forge-finding></forge-blocked>',
    );
    expect(err.message).toContain('forge-finding');
    expect(err.message).toContain('forge-blocked');
  });

  it('refuses a slot standing alone as a body', () => {
    expect(refusal('<forge-summary>x</forge-summary>').message).toMatch(/slot, not a body/);
  });

  it('refuses recursive components (Decision 5)', () => {
    const err = refusal(
      `<forge-review sha="abc1234" verdict="approve"><forge-summary>${review()}</forge-summary></forge-review>`,
    );
    expect(err.message).toContain('forge-review');
  });

  it('enforces the fixed slot order of the issue shapes', () => {
    const err = refusal(
      '<forge-symptom><forge-evidence><forge-row date="2026-09-03" measured="x" source="y" /></forge-evidence><forge-opening>o</forge-opening></forge-symptom>',
    );
    expect(err.message).toMatch(/slot order/);
    expect(err.message).toContain('forge-opening');
  });

  it('refuses markup it cannot read rather than repairing it', () => {
    expect(
      refusal('<forge-review sha="abc1234" verdict="approve"><p>x</forge-review>').message,
    ).toMatch(/tags must nest/);
    expect(refusal('<forge-blocked on="decision">x').message).toMatch(/never closed/);
    expect(refusal('<forge-blocked on=decision>x</forge-blocked>').message).toMatch(
      /must be quoted/,
    );
  });
});

describe('plain markup is repaired and reported, never refused (Decision 3)', () => {
  it('wraps tag-free text in <p> by blank line', () => {
    const out = prepareBody({ raw: 'first line\nstill first\n\nsecond', format: 'html' });
    expect(out.body).toBe('<p>first line\nstill first</p>\n<p>second</p>');
    expect(out.template).toBeNull();
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

describe('forge-diagram is raw text (Decision 6)', () => {
  const mermaid = 'flowchart LR\n  A["x"] --> B["y<br/>z"]\n  B -.-> C';

  it('round-trips content containing --> and <br/> byte-identically', () => {
    const out = prepareBody({
      raw: `<forge-diagram kind="mermaid">${mermaid}</forge-diagram>`,
      format: 'html',
    });
    expect(out.body).toBe(`<forge-diagram kind="mermaid">${mermaid}</forge-diagram>`);
    expect(out.text).toContain('-->');
    expect(out.text).toContain('<br/>');
  });

  it('is declared raw in the registry and in the scanner — the two are one fact', () => {
    for (const name of RAW_TEXT_ELEMENTS) expect(specFor(name)?.raw).toBe(true);
    for (const name of COMPONENT_NAMES) {
      if (specFor(name)?.raw) expect(RAW_TEXT_ELEMENTS.has(name)).toBe(true);
    }
  });
});

describe('the registry itself', () => {
  it('gives every component a spec, and every root component a valid-body test above', () => {
    expect(ROOT_COMPONENT_NAMES.length).toBeGreaterThan(0);
    for (const name of COMPONENT_NAMES) expect(specFor(name)?.name).toBe(name);
  });

  it('accepts a valid body for each root component and refuses a bad attribute on it', () => {
    const valid: Record<string, string> = {
      'forge-triage':
        '<forge-triage complexity="m" category="feature" priority="high">ok</forge-triage>',
      'forge-plan': '<forge-plan approval="auto"><forge-files>a.ts</forge-files></forge-plan>',
      'forge-review': review(),
      'forge-qa-report':
        '<forge-qa-report verdict="pass" env="forge-beta"><forge-case verdict="pass">AC1</forge-case></forge-qa-report>',
      'forge-outcome':
        '<forge-outcome kind="done"><forge-extra-fix file="a.ts">tidied</forge-extra-fix></forge-outcome>',
      'forge-blocked': '<forge-blocked on="decision">which one?</forge-blocked>',
      'forge-close': '<forge-close branch="ISS-898" deploy="ok">shipped</forge-close>',
      'forge-symptom': '<forge-symptom><forge-opening>it 500s</forge-opening></forge-symptom>',
      'forge-problem':
        '<forge-problem><forge-opening>o</forge-opening><forge-who>w</forge-who><forge-diagram kind="mermaid">flowchart LR\n A-->B</forge-diagram><forge-todo>t</forge-todo><forge-evidence><forge-row date="2026-09-03" measured="m" source="s" /></forge-evidence></forge-problem>',
      'forge-diagram': '<forge-diagram kind="mermaid">flowchart LR\n A-->B</forge-diagram>',
      'forge-artifact': '<forge-artifact id="ebcb91c1-1b5f-4fa4-92af-49362d5692de" />',
    };
    for (const name of ROOT_COMPONENT_NAMES) {
      const raw = valid[name];
      expect(raw, `no valid-body fixture for ${name}`).toBeTruthy();
      const out = prepareBody({ raw: raw as string, format: 'html' });
      expect(out.template).toBe(name);
      expect(out.text.length).toBeGreaterThan(0);
      expect(refusal((raw as string).replace(`<${name}`, `<${name} nope="1"`)).message).toContain(
        'nope',
      );
    }
  });
});
