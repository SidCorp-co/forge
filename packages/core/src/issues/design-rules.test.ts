// The design rules (REQ-36 BC-1, BC-2; Issue lifecycle r15 `design-check`): what a design write is
// refused with, and what the check a move into build asks finds missing.

import type { RecordDesignRequest } from '@forge/contracts/issue-design';
import { describe, expect, it } from 'vitest';
import {
  type DesignFacts,
  designCheck,
  designWriteRefusals,
  resolveModules,
} from './design-rules.js';
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
      gaps: [{ part: 'design' }],
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
    // the same gaps as facts, so a client words them without parsing the sentence (ISS-467)
    expect(check.passed ? [] : check.gaps).toEqual([
      { part: 'criterion', criterion: 1 },
      { part: 'criterion', criterion: 3 },
      { part: 'modules' },
    ]);
  });

  it('finds an issue with no criteria incomplete', () => {
    const check = designCheck(facts({ criteria: [] }));
    expect(check.passed ? [] : check.missing).toEqual(['criteria: the issue has none']);
    expect(check.passed ? [] : check.gaps).toEqual([{ part: 'criteria' }]);
  });
});

describe('the module scope (ISS-609)', () => {
  const labels = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'issues' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'db' },
  ];
  const empty = (over: Partial<DesignFacts> = {}) =>
    facts({ design: { modules: [], lines: facts().design?.lines ?? [] }, ...over });

  it('passes a design naming no module where the project declares no module label', () => {
    expect(designCheck(empty({ moduleIds: new Set() }))).toEqual({ passed: true });
  });

  it('names the empty scope a gap once the project declares a module label', () => {
    const check = designCheck(empty());
    expect(check.passed ? [] : check.missing).toEqual([
      'modules: none named, and the project now declares module labels',
    ]);
    expect(check.passed ? [] : check.gaps).toEqual([{ part: 'modules' }]);
  });

  it('takes none where the project declares none, and refuses none where it declares some', () => {
    expect(resolveModules([], [])).toEqual({ ids: [], refusals: [] });
    const required = resolveModules([], labels);
    expect(required.refusals.map((r) => [r.code, r.path])).toEqual([
      ['DESIGN_MODULE_REQUIRED', '/modules'],
    ]);
    expect(required.refusals[0]?.detail).toContain('(db, issues)');
  });

  it('refuses a name on a project with no module label, saying to send none', () => {
    const out = resolveModules(['issues'], []);
    expect(out.refusals.map((r) => [r.code, r.path])).toEqual([
      ['DESIGN_MODULE_UNKNOWN', '/modules/0'],
    ]);
    expect(out.refusals[0]?.detail).toContain('Send `modules: []`');
  });

  it('resolves names and ids once each, and refuses an unknown name at its path', () => {
    const out = resolveModules(['issues', labels[0]?.id ?? '', 'nowhere'], labels);
    expect(out.ids).toEqual([labels[0]?.id]);
    expect(out.refusals.map((r) => [r.code, r.path])).toEqual([
      ['DESIGN_MODULE_UNKNOWN', '/modules/2'],
    ]);
    expect(out.refusals[0]?.detail).toContain('modules/rollup lists them');
  });
});
