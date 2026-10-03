/**
 * The approved design a build job is given: the revision its approver approved, read for every
 * workflow the issue builds (`workflow_builds`), trimmed to the steps, edges and guards that bind
 * the build, and refused by name when that revision cannot be read.
 *
 * Trimming rule. What the code reads of itself (step status, evidence, coverage, drift, the commit
 * a reading was taken at) and the document's stamps are never given: they are not the design. The
 * rest is the slice. A slice over `ARTIFACT_CONTEXT_CAP_CHARS` sheds whole field groups in the fixed
 * order of `TRIM_TIERS`, then whole steps from the end of the document (with the edges that touch
 * them), each named in the block and in the record. Guards — an edge's condition, action, failure
 * path, mapping, payload and idempotency; a node's rule table, validation, permissions and closed
 * value set — are never shed from a step that is given. A design whose header and cut manifest
 * alone exceed its share is refused (`ARTIFACT_CONTEXT_OVER_BUDGET`), never truncated.
 */

import { estimateTokens } from '../lib/token-estimator.js';
import type { DesignStatus } from './design.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';

// cm:why a placeholder priced against the schema's own ceiling (40 steps, one design's header and cut manifest stay under 10k chars), until the record's chars/estTokens of the first twenty build jobs give a measured p90 to set it from — the design note asks for that measurement before a number
export const ARTIFACT_CONTEXT_CAP_CHARS = 24_000;

export const ARTIFACT_CONTEXT_KEY = 'artifactContext';

export type ArtifactKind = 'workflow-design';

/** A `workflow_builds` row joined to the design row of its workflow's approved revision. */
export interface TracedDesignRow {
  workflowId: string;
  flow: string;
  designStatus: DesignStatus | null;
  workflowRevision: number;
  approvedRevision: number | null;
  /** The design row holding `approvedRevision`; null when no row holds it. */
  revisionRow: { document: unknown; decision: string | null } | null;
}

export interface ArtifactCut {
  /** Field groups shed from every step and edge, as `node.<field>` / `edge.<field>`. */
  fields: string[];
  /** Steps given only as a manifest line, in document order. */
  steps: string[];
  /** Edges left out because a step they touch was cut. */
  edges: number;
}

export interface LoadedArtifact {
  kind: ArtifactKind;
  /** The flow slug: what `ARTIFACT_CONTEXT_UNLOADABLE` and a verdict name the design by. */
  ref: string;
  workflowId: string;
  revision: number;
  designStatus: DesignStatus | null;
  workflowRevision: number;
  stepsGiven: number;
  edgesGiven: number;
  text: string;
  chars: number;
  estTokens: number;
  cut: ArtifactCut;
}

export type ArtifactRefusalCode = 'ARTIFACT_CONTEXT_UNLOADABLE' | 'ARTIFACT_CONTEXT_OVER_BUDGET';

/** A traced artefact the job cannot be given, named `<kind> <ref>@<revision>`. */
export class ArtifactContextError extends Error {
  readonly code: ArtifactRefusalCode;
  readonly artifact: {
    kind: ArtifactKind;
    ref: string;
    workflowId: string;
    revision: number | null;
  };

  constructor(
    code: ArtifactRefusalCode,
    artifact: { kind: ArtifactKind; ref: string; workflowId: string; revision: number | null },
    reason: string,
  ) {
    super(
      `${code}: ${artifact.kind} ${artifact.ref}@${artifact.revision ?? 'none'} (workflow ${artifact.workflowId}): ${reason}`,
    );
    this.name = 'ArtifactContextError';
    this.code = code;
    this.artifact = artifact;
  }
}

type Doc = Record<string, unknown>;

interface SliceStep {
  id: string;
  title?: string;
  does: string;
  after: string[];
  node?: Doc;
}

interface Slice {
  title: string;
  summary: string;
  template: string | null;
  lanes: { id: string; label: string }[];
  personas: { id: string; label: string }[];
  steps: SliceStep[];
  edges: Doc[];
}

// cm:why the order fields are shed in when a slice is over budget: rule test cases and wireframe pointers first (fetchable, and restated by the rule and screen they belong to), then descriptive prose; guards are in no tier
export const TRIM_TIERS: readonly { node: readonly string[]; edge: readonly string[] }[] = [
  { node: ['tests'], edge: [] },
  { node: ['wireframe'], edge: [] },
  { node: ['purpose', 'expectedOutcome', 'owner', 'sla', 'channel'], edge: ['label'] },
];

const fetchLine = (workflowId: string) =>
  `\`forge_workflows action=design workflowId=${workflowId}\``;

function readApproved(row: TracedDesignRow): { revision: number; doc: WorkflowWrite } {
  const artifact = {
    kind: 'workflow-design' as const,
    ref: row.flow,
    workflowId: row.workflowId,
    revision: row.approvedRevision,
  };
  const refuse = (reason: string) =>
    new ArtifactContextError('ARTIFACT_CONTEXT_UNLOADABLE', artifact, reason);
  if (row.approvedRevision === null) {
    throw refuse(
      `the design is ${row.designStatus ?? 'not in a design lifecycle'} and names no approved revision, so there is no approved design to give the job`,
    );
  }
  if (!row.revisionRow) {
    throw refuse(`no design revision row holds revision ${row.approvedRevision}`);
  }
  if (row.revisionRow.decision !== 'approve') {
    throw refuse(
      `revision ${row.approvedRevision} is recorded with decision ${row.revisionRow.decision ?? 'none'}, not approve`,
    );
  }
  const doc = readStoredWorkflow(row.revisionRow.document);
  if (!doc) {
    throw refuse(
      `revision ${row.approvedRevision}'s document does not read as workflow-v1 or workflow-v2`,
    );
  }
  return { revision: row.approvedRevision, doc };
}

function sliceOf(doc: WorkflowWrite): Slice {
  const steps = doc.steps.map((s): SliceStep => {
    const node = 'node' in s && s.node ? ({ ...s.node } as Doc) : undefined;
    return {
      id: s.id,
      ...(s.title ? { title: s.title } : {}),
      does: s.does,
      after: [...s.after],
      ...(node ? { node } : {}),
    };
  });
  if (doc.version !== 2) {
    return {
      title: doc.title,
      summary: doc.summary,
      template: null,
      lanes: [],
      personas: [],
      steps,
      edges: [],
    };
  }
  const label = (l: { id: string; label: string }) => ({ id: l.id, label: l.label });
  return {
    title: doc.title,
    summary: doc.summary,
    template: `${doc.template.id}@${doc.template.version}`,
    lanes: (doc.lanes ?? []).map(label),
    personas: (doc.personas ?? []).map(label),
    steps,
    edges: (doc.edges ?? []).map((e) => ({ ...e }) as Doc),
  };
}

const omit = (o: Doc, keys: readonly string[]): Doc =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function renderStep(s: SliceStep): string {
  const node = s.node ?? {};
  const type = typeof node.type === 'string' ? ` · ${node.type}` : '';
  const name = s.title ?? (typeof node.label === 'string' ? node.label : null);
  const lines = [`- \`${s.id}\`${type}${name ? ` · ${name}` : ''} — ${s.does}`];
  lines.push(`  after: ${s.after.length ? s.after.map((a) => `\`${a}\``).join(', ') : '(none)'}`);
  const rest = omit(node, ['type', ...(s.title ? [] : ['label'])]);
  if (Object.keys(rest).length) lines.push(`  contract: ${JSON.stringify(rest)}`);
  return lines.join('\n');
}

function renderEdge(e: Doc): string {
  const kind = typeof e.kind === 'string' ? ` · ${e.kind}` : '';
  const rest = omit(e, ['from', 'to', 'kind']);
  return `- \`${String(e.from)}\` → \`${String(e.to)}\`${kind}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`;
}

function renderDesign(
  row: TracedDesignRow,
  revision: number,
  slice: Slice,
  cutSteps: SliceStep[],
  cut: ArtifactCut,
): string {
  const head = [
    `### ${slice.title} — \`${row.flow}\` at approved revision ${revision}`,
    `Workflow ${row.workflowId}${slice.template ? `, drawn in ${slice.template}` : ''}.`,
    slice.summary,
  ];
  if (row.designStatus !== 'approved') {
    head.push(
      `This design is now ${row.designStatus ?? 'out of its design lifecycle'}; revision ${revision} is the last one its approver approved, and it is what this job is given.`,
    );
  } else if (row.workflowRevision > revision) {
    head.push(
      `The workflow stands at revision ${row.workflowRevision}; nothing its approver decides has changed since revision ${revision}.`,
    );
  }
  if (slice.lanes.length)
    head.push(`Lanes: ${slice.lanes.map((l) => `\`${l.id}\` ${l.label}`).join(', ')}.`);
  if (slice.personas.length)
    head.push(`Personas: ${slice.personas.map((l) => `\`${l.id}\` ${l.label}`).join(', ')}.`);
  const parts = [head.join('\n'), ['Steps:', ...slice.steps.map(renderStep)].join('\n')];
  if (slice.edges.length) parts.push(['Edges:', ...slice.edges.map(renderEdge)].join('\n'));
  if (cut.fields.length || cutSteps.length) {
    const lines = [`Cut to fit the context budget — read them with ${fetchLine(row.workflowId)}:`];
    if (cut.fields.length) lines.push(`- fields: ${cut.fields.join(', ')}`);
    for (const s of cutSteps) {
      const name = s.title ?? (typeof s.node?.label === 'string' ? s.node.label : null);
      lines.push(`- step \`${s.id}\`${name ? ` · ${name}` : ''}`);
    }
    if (cut.edges) lines.push(`- ${cut.edges} edge(s) touching a cut step`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

function shed(slice: Slice, tier: (typeof TRIM_TIERS)[number]): { slice: Slice; shed: string[] } {
  const present = new Set<string>();
  const steps = slice.steps.map((s) => {
    if (!s.node) return s;
    for (const k of tier.node) if (k in s.node) present.add(`node.${k}`);
    return { ...s, node: omit(s.node, tier.node) };
  });
  const edges = slice.edges.map((e) => {
    for (const k of tier.edge) if (k in e) present.add(`edge.${k}`);
    return omit(e, tier.edge);
  });
  const order = [...tier.node.map((k) => `node.${k}`), ...tier.edge.map((k) => `edge.${k}`)];
  return { slice: { ...slice, steps, edges }, shed: order.filter((k) => present.has(k)) };
}

function fitToShare(row: TracedDesignRow, revision: number, full: Slice, capChars: number) {
  const cut: ArtifactCut = { fields: [], steps: [], edges: 0 };
  let slice = full;
  let text = renderDesign(row, revision, slice, [], cut);
  for (const tier of TRIM_TIERS) {
    if (text.length <= capChars) return { slice, text, cut };
    const next = shed(slice, tier);
    slice = next.slice;
    cut.fields.push(...next.shed);
    text = renderDesign(row, revision, slice, [], cut);
  }
  if (text.length <= capChars) return { slice, text, cut };
  for (let keep = slice.steps.length - 1; keep >= 0; keep--) {
    const kept = slice.steps.slice(0, keep);
    const dropped = slice.steps.slice(keep);
    const ids = new Set(kept.map((s) => s.id));
    const edges = slice.edges.filter((e) => ids.has(String(e.from)) && ids.has(String(e.to)));
    const trial: ArtifactCut = {
      fields: cut.fields,
      steps: dropped.map((s) => s.id),
      edges: slice.edges.length - edges.length,
    };
    const trimmed = { ...slice, steps: kept, edges };
    const t = renderDesign(row, revision, trimmed, dropped, trial);
    if (t.length <= capChars) return { slice: trimmed, text: t, cut: trial };
  }
  throw new ArtifactContextError(
    'ARTIFACT_CONTEXT_OVER_BUDGET',
    { kind: 'workflow-design', ref: row.flow, workflowId: row.workflowId, revision },
    `even with every step cut, its header and cut manifest exceed its ${capChars}-char share of the ${ARTIFACT_CONTEXT_CAP_CHARS}-char artefact budget`,
  );
}

/**
 * What a build job is given of the designs its issue builds: each approved revision's slice, fitted
 * to its share of `capChars`. Throws `ArtifactContextError` naming the first design it cannot give.
 */
export function artifactContext(
  rows: readonly TracedDesignRow[],
  capChars: number = ARTIFACT_CONTEXT_CAP_CHARS,
): LoadedArtifact[] {
  if (rows.length === 0) return [];
  const share = Math.floor(capChars / rows.length);
  return [...rows]
    .sort((a, b) => a.flow.localeCompare(b.flow))
    .map((row) => {
      const { revision, doc } = readApproved(row);
      const { slice, text, cut } = fitToShare(row, revision, sliceOf(doc), share);
      return {
        kind: 'workflow-design',
        ref: row.flow,
        workflowId: row.workflowId,
        revision,
        designStatus: row.designStatus,
        workflowRevision: row.workflowRevision,
        stepsGiven: slice.steps.length,
        edgesGiven: slice.edges.length,
        text,
        chars: text.length,
        estTokens: estimateTokens(text),
        cut,
      };
    });
}

/** The prompt block a build job is given; null when its issue builds no design. */
export function renderArtifactContext(loaded: readonly LoadedArtifact[]): string | null {
  if (loaded.length === 0) return null;
  return [
    '## The approved design this issue builds',
    'Build to the revision below: it is what the approver approved. It holds the steps, edges and guards that bind the build; step status, evidence and coverage are the code reading itself and are left out. Read the full design and every revision on demand, never instead of this.',
    ...loaded.map((a) => a.text),
  ].join('\n\n');
}

/** What the job's record keeps of the load: which revision of which design, how much, what was cut. */
export function artifactContextRecord(loaded: readonly LoadedArtifact[], source: string) {
  return {
    source,
    loadedAt: new Date().toISOString(),
    capChars: ARTIFACT_CONTEXT_CAP_CHARS,
    artifacts: loaded.map((a) => ({
      kind: a.kind,
      ref: a.ref,
      workflowId: a.workflowId,
      revision: a.revision,
      designStatus: a.designStatus,
      workflowRevision: a.workflowRevision,
      steps: a.stepsGiven,
      edges: a.edgesGiven,
      chars: a.chars,
      estTokens: a.estTokens,
      cut: a.cut,
    })),
  };
}
