import { ReportFrameSchema } from '@forge/contracts/report-queries';
import type { HealthMarkerKind } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { criteriaCoverageFrame } from './criteria-coverage.js';
import { A3_REPORT_QUERIES } from './phase-a-queries.js';
import { releaseReadinessFrame } from './release-readiness.js';
import { workflowStatusFrame } from './workflow-status.js';

// REQ-32 lane A3: three queries over reads that exist. Each frame must be one the contract accepts
// and must say what the read it summarises says, no more.

const NONE = { progress: { total: 0, shipped: 0, awaitingRelease: 0, toDo: 0 } };
const next = (over: Record<string, unknown> = {}) =>
  ({
    asOf: '2026-10-08T09:00:00.000Z',
    version: '0.4.0',
    state: 'in_progress',
    progress: { total: 5, shipped: 2, awaitingRelease: 1, toDo: 2 },
    requirements: ['REQ-3', 'REQ-7'],
    forecast: null,
    turn: { who: 'Ana', act: 'approve the release', says: {} },
    behind: { version: '0.4.1', issueCount: 3 },
    ...over,
  }) as never;

describe('the registration list', () => {
  it('holds the three queries, each declaring the reads it calls and a valid descriptor', () => {
    expect(A3_REPORT_QUERIES.map((q) => q.descriptor.id)).toEqual([
      'release-readiness',
      'criteria-coverage',
      'workflow-status',
    ]);
    for (const q of A3_REPORT_QUERIES) {
      expect(q.reads.length).toBeGreaterThan(0);
      expect(q.descriptor.permission).toBe('project.read');
      expect(q.descriptor.egress).toBe('product');
    }
  });
});

describe('release-readiness', () => {
  it('answers one row: state, progress, whose turn and the draft behind', () => {
    const frame = releaseReadinessFrame(next());
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.rows).toEqual([
      {
        release: '0.4.0',
        state: 'in_progress',
        total: 5,
        shipped: 2,
        awaitingRelease: 1,
        toDo: 2,
        requirements: 'REQ-3, REQ-7',
        turnWho: 'Ana',
        turnAct: 'approve the release',
        behindRelease: '0.4.1',
        behindIssues: 3,
      },
    ]);
  });

  it('holds null cells where nobody has the turn and nothing is behind', () => {
    const [row] = releaseReadinessFrame(next({ turn: null, behind: null })).rows;
    expect(row).toMatchObject({
      turnWho: null,
      turnAct: null,
      behindRelease: null,
      behindIssues: null,
    });
  });

  it('holds no row where no release is cut or collecting', () => {
    const frame = releaseReadinessFrame(next({ version: null, state: null, ...NONE }));
    expect(frame.rows).toEqual([]);
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
  });
});

const cov = (code: string, verdict: string, ids: string[]) => ({
  code,
  body: `${code} holds`,
  verdict,
  issues: ids.map((displayId) => ({ displayId })),
  uncoveredReason: null,
});
const req = (key: string, coverage: unknown[]) =>
  ({ key, title: `${key} title`, standing: { coverage } }) as never;

describe('criteria-coverage', () => {
  const list = [
    req('REQ-10', [cov('BC-1', 'gap', [])]),
    req('REQ-2', [
      cov('BC-10', 'failing', ['ISS-4', 'ISS-9']),
      cov('BC-2', 'passing', ['ISS-1']),
      cov('BC-3', 'not_judged', ['ISS-5']),
    ]),
  ];

  it('lists each criterion once, requirements and criteria in numeric order, with the issues that trace it', () => {
    const frame = criteriaCoverageFrame(list);
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      frame.rows.map((r) => [r.requirement, r.criterion, r.verdict, r.issues, r.issueCount]),
    ).toEqual([
      ['REQ-2', 'BC-2', 'passing', 'ISS-1', 1],
      ['REQ-2', 'BC-3', 'not_judged', 'ISS-5', 1],
      ['REQ-2', 'BC-10', 'failing', 'ISS-4, ISS-9', 2],
      ['REQ-10', 'BC-1', 'gap', '', 0],
    ]);
  });

  it('keeps the read word for each verdict, never a second vocabulary', () => {
    const verdicts = criteriaCoverageFrame(list).rows.map((r) => r.verdict);
    expect(new Set(verdicts)).toEqual(new Set(['passing', 'not_judged', 'failing', 'gap']));
  });

  it('narrows to one requirement', () => {
    expect(criteriaCoverageFrame(list, 'REQ-10').rows).toHaveLength(1);
  });

  it('holds no rows for a requirement with no criteria', () => {
    expect(criteriaCoverageFrame([req('REQ-1', [])]).rows).toEqual([]);
  });
});

const counts = (over: Partial<Record<HealthMarkerKind, number>> = {}) => ({
  has_problem: 0,
  wrong: 0,
  outdated: 0,
  not_in_design: 0,
  remove_proposed: 0,
  needs_update: 0,
  upcoming: 0,
  ...over,
});
const design = (flow: string, nodes: unknown[], c = counts(), needsYou = 0) =>
  ({ flow, counts: c, needsYou, nodes, markers: [] }) as never;
const step = (id: string, kinds: HealthMarkerKind[]) => ({
  target: { kind: 'step', step: id, layer: 'planned' },
  provenance: 'matched',
  kinds,
  rewrite: 'none',
});
const edge = (from: string, to: string) => ({
  target: { kind: 'edge', from, to, label: null, layer: 'planned' },
  provenance: 'planned',
  kinds: [],
  rewrite: 'none',
});

describe('workflow-status', () => {
  const designs = [
    design(
      'intake',
      [step('open', ['outdated', 'has_problem']), edge('open', 'close')],
      counts({ outdated: 1, has_problem: 1 }),
      2,
    ),
    design('alpha', []),
  ];

  it('gives each design a row, then its steps and edges as a graph', () => {
    const frame = workflowStatusFrame(designs);
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.rows.map((r) => [r.flow, r.kind, r.node, r.from, r.to])).toEqual([
      ['alpha', 'design', null, null, null],
      ['intake', 'design', null, null, null],
      ['intake', 'step', 'open', null, null],
      ['intake', 'edge', 'open -> close', 'open', 'close'],
    ]);
  });

  it('names each marker in the vocabulary the screens use, and counts them', () => {
    const rows = workflowStatusFrame(designs).rows;
    expect(rows[1]).toMatchObject({
      markers: 'Has a problem 1, Outdated 1',
      markerCount: 2,
      needsYou: 2,
    });
    expect(rows[2]).toMatchObject({
      markers: 'Outdated, Has a problem',
      markerCount: 2,
      provenance: 'matched',
    });
    expect(rows[3]).toMatchObject({ markers: '', markerCount: 0 });
  });

  it('narrows to one design', () => {
    expect(workflowStatusFrame(designs, 'alpha').rows).toHaveLength(1);
  });
});
