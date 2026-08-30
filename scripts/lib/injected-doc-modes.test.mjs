// The rule these assert is "name the mode you mean", not "never name these
// statuses" — so the cases that matter most are the ones that must stay SILENT:
// a create-time choice, a transition the driver can make, and a line rendered
// from project data. A gate that fired on those would be turned off in a week.

import { describe, expect, it } from 'vitest';
import {
  checkSurface,
  extractBodies,
  isModeQualified,
  transitionsOnLine,
} from './injected-doc-modes.mjs';

const ALL = [
  'open',
  'confirmed',
  'clarified',
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'testing',
  'tested',
  'released',
  'closed',
  'reopen',
  'on_hold',
  'needs_info',
  'draft',
  'dropped',
];
const DRIVER = ['open', 'in_progress', 'needs_info', 'closed', 'dropped'];

const on = (line) => transitionsOnLine(line, ALL, DRIVER);

describe('transitionsOnLine', () => {
  it('reports a paired transition whose target the driver cannot write', () => {
    expect(on('move it `waiting` → `approved` to release the gate')).toEqual([
      { from: 'waiting', to: 'approved', form: 'paired' },
    ]);
  });

  it('accepts the ascii arrow the same as the unicode one', () => {
    expect(on('`waiting` -> `approved`')).toHaveLength(1);
  });

  it('stays silent when the target is a status the driver CAN write', () => {
    expect(on('the parent goes `waiting` → `open` on this project')).toEqual([]);
  });

  it('stays silent on a directed arrow with no transition verb, which is a create-time choice', () => {
    expect(on('- Work for later, or a follow-up you just want recorded → `draft`.')).toEqual([]);
  });

  it('reports a directed arrow once a transition verb puts it in motion', () => {
    expect(on('A human approving the parent (→ `approved`) auto-cascades the children')).toEqual([
      { from: null, to: 'approved', form: 'directed' },
    ]);
  });

  it('does not double-report a target already found in paired form', () => {
    expect(on('approving `waiting` → `approved` promotes it (→ `approved`)')).toEqual([
      { from: 'waiting', to: 'approved', form: 'paired' },
    ]);
  });

  it('stays silent on a line rendered from project data, which names no fixed ladder', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` is the input under test — it is what marks a line as project-resolved
    expect(on('`${ladder.join(" → ")}` — `waiting` → `approved`')).toEqual([]);
  });

  it('finds every hop of a multi-arrow ladder', () => {
    const hops = on('`open → confirmed → clarified → approved`');
    expect(hops.map((h) => `${h.from}->${h.to}`)).toEqual([
      'open->confirmed',
      'clarified->approved',
    ]);
  });
});

describe('isModeQualified', () => {
  it.each([
    ['| staged (the default) | `waiting → approved` |', true],
    ['on an `autonomous` project the driver writes `open`', true],
    ['A human approving the parent auto-cascades the children', false],
  ])('%s → %s', (line, expected) => {
    expect(isModeQualified(line)).toBe(expected);
  });
});

describe('checkSurface', () => {
  const surface = (text) => ({ file: 'f.ts', bodies: [{ startLine: 10, text }] });

  it('counts a qualified transition as checked without reporting it', () => {
    const r = checkSurface(
      surface('on a staged project it goes `waiting` → `approved`'),
      ALL,
      DRIVER,
    );
    expect(r.violations).toEqual([]);
    expect(r.transitionsChecked).toBe(1);
  });

  it('reports the line in the SOURCE file, not the offset inside the template literal', () => {
    const r = checkSurface(surface('intro\nmoving `waiting` → `approved`'), ALL, DRIVER);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].line).toBe(11);
    expect(r.violations[0].file).toBe('f.ts');
  });

  it('reports nothing when the driver vocabulary covers every target', () => {
    const r = checkSurface(surface('moving `waiting` → `open`'), ALL, ['open', 'waiting']);
    expect(r.violations).toEqual([]);
  });
});

describe('extractBodies', () => {
  it('unescapes backticks so an inline code span reads as markdown, not as source', () => {
    const [body] = extractBodies('const A = `a \\`waiting\\` b`;', ['const \\w+ =']);
    expect(body.text).toBe('a `waiting` b');
  });

  it('ends the body at the first UNescaped backtick', () => {
    const [body] = extractBodies('const A = `one`; const B = `two`;', ['const A =']);
    expect(body.text).toBe('one');
  });

  it('records the line the body opened on', () => {
    const [body] = extractBodies('x\ny\nconst A = `hi`;', ['const \\w+ =']);
    expect(body.startLine).toBe(3);
  });

  it('returns nothing when the opener matches no declaration, so the CLI can fail closed', () => {
    expect(extractBodies('const A = `hi`;', ['body:'])).toEqual([]);
  });
});
