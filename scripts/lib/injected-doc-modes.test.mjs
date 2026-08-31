// The rule these assert is "name the mode you mean", not "never name these
// statuses" — so the cases that matter most are the ones that must stay SILENT:
// a create-time choice, a transition the driver can make, and a line rendered
// from project data. A gate that fired on those would be turned off in a week.

import { describe, expect, it } from 'vitest';
import {
  checkSurface,
  extractBodies,
  isModeQualified,
  sentencesOf,
  stepClaimsInSentence,
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
const STEPS = ['triage', 'clarify', 'plan', 'code', 'review', 'test', 'fix', 'release', 'drive'];
const RULES = { allStatuses: ALL, driverStatuses: DRIVER, stepNames: STEPS };

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
    const r = checkSurface(surface('on a staged project it goes `waiting` → `approved`'), RULES);
    expect(r.violations).toEqual([]);
    expect(r.transitionsChecked).toBe(1);
  });

  it('reports the line in the SOURCE file, not the offset inside the template literal', () => {
    const r = checkSurface(surface('intro\nmoving `waiting` → `approved`'), RULES);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].line).toBe(11);
    expect(r.violations[0].file).toBe('f.ts');
  });

  it('reports nothing when the driver vocabulary covers every target', () => {
    const r = checkSurface(surface('moving `waiting` → `open`'), {
      ...RULES,
      driverStatuses: ['open', 'waiting'],
    });
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

describe('stepClaimsInSentence', () => {
  const claims = (s) => stepClaimsInSentence(s, STEPS).map((c) => c.steps);

  it('reports a step named as the agent of what the reader is told', () => {
    expect(claims('those are written by the clarify/plan steps')).toEqual(['clarify/plan']);
  });

  it('reports a step named as the subject of an adjacent verb', () => {
    expect(claims('a design the plan step exists to decide')).toEqual(['plan']);
  });

  it('reads a coordinated list as one claim, not as the last name in it', () => {
    expect(claims('Those are written by the clarify and plan steps')).toEqual(['clarify and plan']);
  });

  // cm:guard the two silent cases below are LIVE lines on this tree whose correct fix is no change — the only way to satisfy a rule that flagged them is to add a mode name that makes the doc state something false, and a gate with that property gets waived rather than obeyed. Widening `namesStepAsActor` is what breaks them: measured 2026-08-31, a bare active verb anywhere in the sentence catches `after your write`, and a possessive catches `the release stage's gate`.
  it('stays silent on a step named possessively, which claims nothing about the reader', () => {
    expect(claims("a deploy outside the release stage's human-confirm gate is a red flag")).toEqual(
      [],
    );
  });

  it('stays silent on a step named as a CONDITION, which simply never fires without it', () => {
    expect(
      claims(
        'On a review or test step that rejects (sets `reopen`), append one entry after your write',
      ),
    ).toEqual([]);
  });

  it('stays silent on a line rendered from project data', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` is the input under test
    expect(claims('written by the ${cfg.step} steps')).toEqual([]);
  });
});

describe('sentencesOf', () => {
  it('joins a wrapped claim, which a per-line scan reads as an agent and a step that never meet', () => {
    const [s] = sentencesOf('Those are written by the\n  clarify and plan steps.');
    expect(stepClaimsInSentence(s.text, STEPS)).toHaveLength(1);
  });

  it('points at the line the step name is ON, not at the line the sentence opened on', () => {
    const body = { startLine: 100, text: 'Those are written by the\n  clarify and plan steps.' };
    const r = checkSurface({ file: 'f.ts', bodies: [body] }, RULES);
    expect(r.violations[0].line).toBe(101);
  });

  it('keeps a table row out of its neighbours, so one row cannot qualify the next', () => {
    const text = '| on a staged project it is fine |\n| written by the plan steps |';
    const r = checkSurface({ file: 'f.ts', bodies: [{ startLine: 1, text }] }, RULES);
    expect(r.violations.map((v) => v.line)).toEqual([2]);
  });
});

describe('checkSurface counts each rule separately', () => {
  it('counts a qualified step claim as checked without reporting it', () => {
    const text = 'on a staged project those are written by the plan steps';
    const r = checkSurface({ file: 'f.ts', bodies: [{ startLine: 1, text }] }, RULES);
    expect(r.violations).toEqual([]);
    expect(r.stepClaimsChecked).toBe(1);
  });

  // cm:guard the two counts must stay INDEPENDENT. A single shared "found nothing" total lets a botched R2 regex ride R1's non-zero count into a green build, which is how a rule that matches nothing becomes indistinguishable from a rule that is satisfied.
  it('reports zero step claims while still finding transitions', () => {
    const r = checkSurface(
      { file: 'f.ts', bodies: [{ startLine: 1, text: 'moving `waiting` → `approved`' }] },
      RULES,
    );
    expect(r.transitionsChecked).toBe(1);
    expect(r.stepClaimsChecked).toBe(0);
  });
});
