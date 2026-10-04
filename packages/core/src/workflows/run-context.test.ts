import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pinnedContractProblem, renderPinnedContracts } from './pinned-contracts.js';
import {
  type RequirementContextRow,
  renderIssueMockups,
  requirementContext,
} from './requirement-context.js';
import {
  ARTIFACT_CONTEXT_CAP_CHARS,
  artifactContext,
  artifactContextRecord,
  renderArtifactContext,
  type TracedDesignRow,
} from './run-context.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

const design = (): Doc =>
  JSON.parse(
    readFileSync(new URL('./fixtures/post-discharge.design.json', import.meta.url), 'utf8'),
  );

const WORKFLOW = '7a1d4c0e-1111-4111-8111-111111111111';

const traced = (over: Partial<TracedDesignRow> = {}, doc: Doc = design()): TracedDesignRow => ({
  workflowId: WORKFLOW,
  flow: 'post-discharge',
  designStatus: 'approved',
  workflowRevision: 1,
  approvedRevision: 1,
  revisionRow: { document: doc, decision: 'approve' },
  ...over,
});

describe('a build job is given the approved design revision its issue builds', () => {
  it('gives the steps, edges and guards of the approved revision, and none of its stamps', () => {
    const doc = design();
    const [loaded] = artifactContext([traced({}, doc)]);
    const text = renderArtifactContext(loaded ? [loaded] : []) ?? '';

    expect(loaded).toMatchObject({
      kind: 'workflow-design',
      ref: 'post-discharge',
      revision: 1,
      stepsGiven: doc.steps.length,
      edgesGiven: doc.edges.length,
      cut: { fields: [], steps: [], edges: 0 },
    });
    expect(text).toContain('## The approved design this issue builds');
    expect(text).toContain('`post-discharge` at approved revision 1');
    for (const s of doc.steps) expect(text).toContain(`- \`${s.id}\``);
    expect(text).toContain('"when":"episode.risk == high"');
    expect(text).toContain('"onFailure":"retry the feed, then raise to IT"');
    expect(text).toContain('- `his` → `discharged`');
    expect(text).not.toContain('"createdAt"');
  });

  it('says when the design moved on past the revision it gives, never loading the newer one silently', () => {
    const [refreshed] = artifactContext([traced({ workflowRevision: 4, approvedRevision: 2 })]);
    expect(refreshed?.text).toContain(
      'The workflow stands at revision 4; nothing its approver decides has changed since revision 2.',
    );
    const [proposed] = artifactContext([traced({ designStatus: 'proposed', approvedRevision: 2 })]);
    expect(proposed?.text).toContain(
      'This design is now proposed; revision 2 is the last one its approver approved',
    );
  });

  it('gives an issue that builds no design nothing, and renders no block', () => {
    expect(artifactContext([])).toEqual([]);
    expect(renderArtifactContext([])).toBeNull();
  });
});

describe('a job on an issue with a requirement is given the design revisions its baseline pins', () => {
  const pinned = (currentApproved: number | null) =>
    traced({ approvedRevision: 2, workflowRevision: 3, pinnedBy: { key: 'REQ-7', currentApproved } });

  it('gives the pinned revision, says who pinned it, and records it', () => {
    const loaded = artifactContext([pinned(2)]);
    const text = renderArtifactContext(loaded) ?? '';
    expect(loaded[0]).toMatchObject({ revision: 2, pinnedBy: 'REQ-7' });
    expect(text).toContain("## The designs REQ-7's latest baseline pins");
    expect(text).toContain("`post-discharge` at revision 2, pinned by REQ-7's latest baseline");
    expect(artifactContextRecord(loaded, 'baseline-pins').artifacts[0]).toMatchObject({
      revision: 2,
      pinnedBy: 'REQ-7',
    });
  });

  it('refuses a pin the design was approved past, never giving the superseded revision', () => {
    expect(() => artifactContext([pinned(3)])).toThrow(
      /^REQUIREMENT_REVISION_NOT_CURRENT: workflow-design post-discharge@2 .*REQ-7's latest baseline pins revision 2, and the design is approved at revision 3 now/,
    );
  });
});

describe('a job is given the contract versions its requirement pins, and nothing else', () => {
  const versions = [
    { version: '1.1.0', approval: 'proposed' },
    { version: '1.0.0', approval: 'approved' },
    { version: '0.9.0', approval: 'approved' },
  ];

  it('gives the pinned version while it is the current one', () => {
    expect(pinnedContractProblem('REQ-7', 'hop/api', '1.0.0', versions)).toBeNull();
  });

  it('refuses a superseded pin as REQUIREMENT_REVISION_NOT_CURRENT naming the current version', () => {
    const e = pinnedContractProblem('REQ-7', 'hop/api', '0.9.0', versions);
    expect(e?.code).toBe('REQUIREMENT_REVISION_NOT_CURRENT');
    expect(e?.message).toContain('1.0.0 is the current version now');
  });

  it('refuses a pin naming a version not approved or never recorded, by name', () => {
    expect(pinnedContractProblem('REQ-7', 'hop/api', '1.1.0', versions)?.message).toMatch(
      /^ARTIFACT_CONTEXT_UNLOADABLE: contract-version hop\/api@1.1.0: .* it is proposed/,
    );
    expect(pinnedContractProblem('REQ-7', 'hop/api', '2.0.0', versions)?.message).toContain(
      'its provider holds no such version',
    );
  });

  it('renders each pinned version with its elements and its artifact route', () => {
    const text =
      renderPinnedContracts('REQ-7', [
        {
          ref: 'hop/api',
          providerProjectId: 'p1',
          contractSlug: 'api',
          version: '1.0.0',
          type: 'openapi',
          elements: ['GET /a'],
          artifact: '{"openapi":"3.1.0"}',
          sha256: 'abc',
        },
      ]) ?? '';
    expect(text).toContain("## The contract versions REQ-7's latest baseline pins");
    expect(text).toContain('### hop/api@1.0.0 (openapi)');
    expect(text).toContain('/api/projects/p1/contracts/api/versions/1.0.0/artifact');
    expect(renderPinnedContracts('REQ-7', [])).toBeNull();
  });
});

describe('a traced revision that cannot be read refuses the job by name', () => {
  const refusal = (row: TracedDesignRow) => () => artifactContext([row]);

  it('refuses a revision no design row holds', () => {
    expect(refusal(traced({ revisionRow: null }))).toThrow(
      /^ARTIFACT_CONTEXT_UNLOADABLE: workflow-design post-discharge@1 \(workflow 7a1d4c0e-1111-4111-8111-111111111111\): no design revision row holds revision 1$/,
    );
  });

  it('refuses a document that does not read as a workflow', () => {
    expect(
      refusal(traced({ revisionRow: { document: { steps: 'x' }, decision: 'approve' } })),
    ).toThrow(
      /^ARTIFACT_CONTEXT_UNLOADABLE: workflow-design post-discharge@1 .*does not read as workflow-v1 or workflow-v2$/,
    );
  });

  it('refuses a revision row that was not the approved one', () => {
    expect(refusal(traced({ revisionRow: { document: design(), decision: 'return' } }))).toThrow(
      /ARTIFACT_CONTEXT_UNLOADABLE: workflow-design post-discharge@1 .*decision return, not approve/,
    );
  });

  it('refuses a design that names no approved revision', () => {
    expect(refusal(traced({ designStatus: 'proposed', approvedRevision: null }))).toThrow(
      /ARTIFACT_CONTEXT_UNLOADABLE: workflow-design post-discharge@none .*names no approved revision/,
    );
  });
});

describe('the record keeps which revision of which design the job was given', () => {
  it('names kind, ref, revision, size and cut for each design', () => {
    const loaded = artifactContext([traced({ workflowRevision: 3, approvedRevision: 2 })]);
    const record = artifactContextRecord(loaded, 'workflow-builds');
    expect(record).toMatchObject({
      source: 'workflow-builds',
      capChars: ARTIFACT_CONTEXT_CAP_CHARS,
      artifacts: [
        {
          kind: 'workflow-design',
          ref: 'post-discharge',
          workflowId: WORKFLOW,
          revision: 2,
          designStatus: 'approved',
          workflowRevision: 3,
          steps: design().steps.length,
          edges: design().edges.length,
          chars: loaded[0]?.chars,
          estTokens: expect.any(Number),
          cut: { fields: [], steps: [], edges: 0 },
        },
      ],
    });
    expect(Number.isNaN(Date.parse(record.loadedAt))).toBe(false);
  });
});

describe('a design over the budget is trimmed by rule, and every cut is named', () => {
  const full = artifactContext([traced()])[0];
  const size = full?.chars ?? 0;

  it('never trims a design inside its budget', () => {
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(ARTIFACT_CONTEXT_CAP_CHARS);
    expect(full?.cut).toEqual({ fields: [], steps: [], edges: 0 });
  });

  it('sheds field groups in tier order before any step, keeping the guards', () => {
    const doc = design();
    doc.steps[3].node.tests = ['high risk -> follow-up required'];
    doc.steps[3].node.purpose = 'x'.repeat(300);
    const tight = artifactContext([traced({}, doc)])[0]?.chars ?? 0;
    const [loaded] = artifactContext([traced({}, doc)], tight - 330);
    expect(loaded?.cut).toEqual({
      fields: ['node.tests', 'node.purpose', 'node.owner', 'node.sla', 'edge.label'],
      steps: [],
      edges: 0,
    });
    expect(loaded?.text).toContain(
      '- fields: node.tests, node.purpose, node.owner, node.sla, edge.label',
    );
    expect(loaded?.text).toContain('"when":"episode.risk == high"');
    expect(loaded?.text).toContain('"onFailure":"retry the feed, then raise to IT"');
    expect(loaded?.chars).toBeLessThanOrEqual(tight - 330);
  });

  it('then cuts whole steps from the end, naming each with the edges that went with it', () => {
    const cap = Math.floor(size / 2);
    const [loaded] = artifactContext([traced()], cap);
    const doc = design();
    expect(loaded?.chars).toBeLessThanOrEqual(cap);
    expect(loaded?.cut.steps.length).toBeGreaterThan(0);
    const kept = doc.steps.slice(0, doc.steps.length - (loaded?.cut.steps.length ?? 0));
    expect(loaded?.cut.steps).toEqual(doc.steps.slice(kept.length).map((s: Doc) => s.id));
    expect(loaded?.stepsGiven).toBe(kept.length);
    expect((loaded?.edgesGiven ?? 0) + (loaded?.cut.edges ?? 0)).toBe(doc.edges.length);
    for (const id of loaded?.cut.steps ?? []) expect(loaded?.text).toContain(`- step \`${id}\``);
    expect(loaded?.text).toContain(
      `forge_workflows action=design workflowId=${WORKFLOW} view=steps revision=`,
    );
    expect(artifactContext([traced()], cap)[0]?.text).toBe(loaded?.text);
  });

  it('refuses by name a design whose header and cut manifest alone exceed its share', () => {
    expect(() => artifactContext([traced()], 200)).toThrow(
      /^ARTIFACT_CONTEXT_OVER_BUDGET: workflow-design post-discharge@1 .*200-char share/,
    );
  });
});

describe('requirementContext (ISS-57)', () => {
  const row = (over: Partial<RequirementContextRow> = {}): RequirementContextRow => ({
    requirementId: 'r1',
    key: 'REQ-12',
    title: 'Follow-up reminders',
    status: 'agreed',
    currentRevision: 4,
    headState: 'current',
    tldr: 'Patients get reminded before a follow-up visit.',
    goal: null,
    criteria: [
      { id: 'c1', code: 'BC-1', body: 'An SMS is sent 3 days before', form: 'statement' },
      {
        id: 'c2',
        code: 'BC-3',
        body: 'Given a visit\nWhen 3 days remain\nThen an SMS',
        form: 'scenario',
      },
    ],
    baseline: {
      revision: 4,
      seq: 1,
      agreedAt: '2026-10-03T00:00:00.000Z',
      pins: [
        {
          workflowId: 'w1',
          flow: 'discharge',
          designRevision: 3,
          contractSlug: null,
          contractVersion: null,
          providerProjectId: null,
        },
      ],
      mockups: [],
    },
    plannedRevision: 4,
    plannedBaselineSeq: 1,
    plan: 'the plan',
    ...over,
  });

  it('gives nothing for an issue that delivers no requirement', () => {
    expect(requirementContext(null)).toBeNull();
  });

  it('gives the current revision, its criteria and the pinned design revisions, and records them', () => {
    const loaded = requirementContext(row());
    expect(loaded?.revision).toBe(4);
    expect(loaded?.text).toContain('BC-1: An SMS is sent 3 days before');
    expect(loaded?.text).toContain('BC-3 (scenario)');
    expect(loaded?.text).toContain('design `discharge` at revision 3');
    expect(loaded?.changedSincePlan).toBe(false);
    const record = artifactContextRecord([], 'workflow-builds+requirement', loaded ?? null);
    expect(record.requirement).toMatchObject({
      key: 'REQ-12',
      revision: 4,
      baselineRevision: 4,
      criteria: [
        { id: 'c1', code: 'BC-1' },
        { id: 'c2', code: 'BC-3' },
      ],
    });
  });

  it('refuses a head that is not current (REQUIREMENT_REVISION_NOT_CURRENT)', () => {
    expect(() => requirementContext(row({ headState: 'superseded' }))).toThrow(
      /REQUIREMENT_REVISION_NOT_CURRENT/,
    );
    expect(() => requirementContext(row({ currentRevision: null, headState: null }))).toThrow(
      /REQUIREMENT_REVISION_NOT_CURRENT/,
    );
  });

  it('refuses a latest baseline that pins another revision than the current one', () => {
    expect(() =>
      requirementContext(
        row({
          baseline: {
            revision: 3,
            seq: 1,
            agreedAt: '2026-10-01T00:00:00.000Z',
            pins: [],
            mockups: [],
          },
        }),
      ),
    ).toThrow(
      /REQUIREMENT_REVISION_NOT_CURRENT: requirement REQ-12: its latest baseline pins revision 3/,
    );
  });

  it('refuses a requirement with no baseline (REQUIREMENT_NOT_AGREED)', () => {
    expect(() => requirementContext(row({ baseline: null }))).toThrow(/REQUIREMENT_NOT_AGREED/);
  });

  it('tells the run when its revision was re-pinned onto newly approved designs after its plan (ISS-86)', () => {
    const base = row();
    const repinned = row({
      baseline: { ...(base.baseline as NonNullable<typeof base.baseline>), seq: 2 },
    });
    const loaded = requirementContext(repinned);
    expect(loaded?.changedSincePlan).toBe(true);
    expect(loaded?.text).toContain('re-pinned onto newly approved designs');
    expect(
      requirementContext(row({ plannedBaselineSeq: 2, baseline: repinned.baseline }))
        ?.changedSincePlan,
    ).toBe(false);
  });

  it('names each pinned mockup with its fetch, and withholds the fetch on a no_egress project (ISS-78)', () => {
    const base = row();
    const mk = {
      key: 'MK-2',
      kind: 'wireframe',
      name: 'list.wireframe.json',
      caption: 'ward filter',
    };
    const pinned = row({
      baseline: { ...(base.baseline as NonNullable<typeof base.baseline>), mockups: [mk] },
    });
    const loaded = requirementContext(pinned);
    expect(loaded?.mockups).toEqual(['MK-2']);
    expect(loaded?.text).toContain(
      '- MK-2 wireframe `list.wireframe.json` — ward filter — `forge_mockups action=content ref=MK-2`',
    );
    expect(requirementContext(pinned, true)?.text).toContain(
      'bytes withheld: this project is no_egress',
    );
    expect(renderIssueMockups([], false)).toBeNull();
    expect(renderIssueMockups([mk], false)).toContain('## Mockups accepted on this issue');
  });

  it('tells the run when the requirement changed since its plan', () => {
    const loaded = requirementContext(row({ plannedRevision: 3 }));
    expect(loaded?.changedSincePlan).toBe(true);
    expect(loaded?.text).toContain('REQUIREMENT_CHANGED_SINCE_PLAN');
  });
});
