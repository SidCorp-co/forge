import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
  it('gives the steps, edges and guards of the approved revision, and none of the code reading itself', () => {
    const doc = design();
    doc.steps[0].evidence = {
      kind: 'storefront',
      provider: 'autoflow',
      ref: 'workflow',
      id: 'SECRET_EVIDENCE_ID',
    };
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
    expect(text).not.toContain('SECRET_EVIDENCE_ID');
    expect(text).not.toContain('"status"');
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
    expect(loaded?.text).toContain(`forge_workflows action=design workflowId=${WORKFLOW}`);
    expect(artifactContext([traced()], cap)[0]?.text).toBe(loaded?.text);
  });

  it('refuses by name a design whose header and cut manifest alone exceed its share', () => {
    expect(() => artifactContext([traced()], 200)).toThrow(
      /^ARTIFACT_CONTEXT_OVER_BUDGET: workflow-design post-discharge@1 .*200-char share/,
    );
  });
});
