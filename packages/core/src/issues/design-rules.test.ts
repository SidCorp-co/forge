// The design rules (REQ-36 BC-1, BC-2; Issue lifecycle r15 `design-check`): what a design write is
// refused with, and what the check a move into build asks finds missing.

import type { RecordDesignRequest } from '@forge/contracts/issue-design';
import { describe, expect, it } from 'vitest';
import { type DesignFacts, designCheck, designWriteRefusals } from './design-rules.js';
import type { PatternRowFacts } from './pattern-rules.js';

const catalog = { kind: 'read' as const, slugs: new Set(['api-route', 'core-module']) };
const criteria = [
  { id: 'c1', n: 1, statement: 'It shows.' },
  { id: 'c2', n: 2, statement: 'One writer.' },
];

function facts(over: Partial<DesignFacts> = {}): DesignFacts {
  return {
    issueRef: 'ISS-9',
    catalog,
    criteria,
    patterns: [],
    design: {
      modules: ['m1'],
      lines: [
        { criterionId: 'c1', criterionClass: 'observable', pattern: 'api-route', proof: 'call it' },
        {
          criterionId: 'c2',
          criterionClass: 'code_property',
          pattern: 'core-module',
          proof: 'review it',
        },
      ],
    },
    moduleIds: new Set(['m1']),
    ...over,
  };
}

const body = (lines: RecordDesignRequest['criteria']): RecordDesignRequest => ({
  criteria: lines,
  modules: ['issues'],
  contracts: [],
});

const approved = (pattern: string): PatternRowFacts => ({
  id: 'p1',
  pattern,
  kind: 'new',
  namedBy: 'u1',
  namedSession: null,
  createdAt: new Date(),
  decision: 'approved',
  decidedAt: new Date(),
  retractedAt: null,
});

describe('designWriteRefusals', () => {
  it('takes one line per criterion naming a catalogued pattern', () => {
    expect(
      designWriteRefusals(
        body([
          { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'call it' },
          { criterion: 2, class: 'code_property', pattern: 'core-module', proof: 'review it' },
        ]),
        facts(),
      ),
    ).toEqual([]);
  });

  it('refuses an unknown, a repeated and a left-out criterion by name', () => {
    const codes = designWriteRefusals(
      body([
        { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'a' },
        { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'b' },
        { criterion: 7, class: 'observable', pattern: 'api-route', proof: 'c' },
      ]),
      facts(),
    ).map((r) => [r.code, r.path]);
    expect(codes).toEqual([
      ['DESIGN_CRITERION_REPEATED', '/criteria/1/criterion'],
      ['DESIGN_CRITERION_UNKNOWN', '/criteria/2/criterion'],
      ['DESIGN_CRITERION_LEFT_OUT', '/criteria'],
    ]);
  });

  it('takes an uncatalogued pattern only once it is approved as new on the issue', () => {
    const lines = body([
      { criterion: 1, class: 'observable', pattern: 'webhook-door', proof: 'a' },
      { criterion: 2, class: 'code_property', pattern: null, proof: 'b' },
    ]);
    expect(designWriteRefusals(lines, facts()).map((r) => r.code)).toEqual([
      'DESIGN_PATTERN_UNCATALOGUED',
      'DESIGN_PATTERN_REQUIRED',
    ]);
    const pending = { ...approved('webhook-door'), decision: null, decidedAt: null };
    expect(designWriteRefusals(lines, facts({ patterns: [pending] })).map((r) => r.code)[0]).toBe(
      'DESIGN_PATTERN_UNCATALOGUED',
    );
    expect(
      designWriteRefusals(lines, facts({ patterns: [approved('webhook-door')] })).map(
        (r) => r.code,
      ),
    ).toEqual(['DESIGN_PATTERN_REQUIRED']);
  });

  it('takes no pattern where the project reads no catalog, and refuses one there', () => {
    const undeclared = { kind: 'undeclared' as const, detail: 'no catalog' };
    const lines = body([
      { criterion: 1, class: 'observable', pattern: null, proof: 'a' },
      { criterion: 2, class: 'code_property', pattern: 'api-route', proof: 'b' },
    ]);
    expect(
      designWriteRefusals(lines, facts({ catalog: undeclared })).map((r) => [r.code, r.path]),
    ).toEqual([['DESIGN_PATTERN_UNDECLARED', '/criteria/1/pattern']]);
  });
});

describe('designCheck', () => {
  it('passes a whole design', () => {
    expect(designCheck(facts())).toEqual({ passed: true });
  });

  it('names a missing design as missing', () => {
    expect(designCheck(facts({ design: null }))).toMatchObject({
      passed: false,
      code: 'DESIGN_RECORD_MISSING',
    });
  });

  it('names each part a recorded design no longer covers', () => {
    const check = designCheck(
      facts({
        criteria: [...criteria, { id: 'c3', n: 3, statement: 'New.' }],
        moduleIds: new Set(),
        catalog: { kind: 'read', slugs: new Set(['core-module']) },
      }),
    );
    expect(check).toMatchObject({ passed: false, code: 'DESIGN_RECORD_INCOMPLETE' });
    expect(check.passed ? [] : check.missing).toEqual([
      'criterion 1: DESIGN_PATTERN_UNCATALOGUED',
      'criterion 3: no class, pattern or proof (written or reworded since)',
      'module m1: no longer a module of the project',
    ]);
  });

  it('finds an issue with no criteria incomplete', () => {
    const check = designCheck(facts({ criteria: [] }));
    expect(check.passed ? [] : check.missing).toEqual(['criteria: the issue has none']);
  });
});
