/**
 * The requirement a build job is given (ISS-57): its current revision's business criteria, the
 * design revisions and mockups its latest baseline pins, and whether it changed since the plan;
 * refused by name when it cannot be given at its current revision.
 */

import type { ArtifactContextRefusalCode } from '@forge/contracts/workflows';
import { RefusalError } from '../lib/refusal.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { changedSincePlan } from '../requirements/rules.js';
import { fetchLine, planLine } from './run-context-plan.js';

export interface RequirementPinRow {
  workflowId: string | null;
  flow: string | null;
  designRevision: number | null;
  contractSlug: string | null;
  contractVersion: string | null;
  providerProjectId: string | null;
}

/** A mockup a job is given by name: an accepted one its requirement's baseline pins, or its issue holds. */
export interface MockupContextRow {
  key: string;
  kind: string;
  name: string;
  caption: string | null;
}

// cm:why a job is given each accepted mockup as a manifest line and a fetch, never its bytes: an
// image or a board read on demand costs only the run that needs it, and at no_egress the bytes are
// withheld (surface `mockup.content`), so the line says so instead of offering a fetch that refuses
export function mockupLines(rows: readonly MockupContextRow[], withheld: boolean): string[] {
  return rows.map(
    (m) =>
      `- ${m.key} ${m.kind} \`${m.name}\`${m.caption ? ` — ${m.caption}` : ''} — ${withheld ? 'bytes withheld: this project is no_egress' : `\`GET /api/projects/:id/mockups/${m.key}/content\``}`,
  );
}

/** The mockups accepted on the issue itself, as the job's own block; null when there are none. */
export function renderIssueMockups(
  rows: readonly MockupContextRow[],
  withheld: boolean,
): string | null {
  if (!rows.length) return null;
  return [
    '## Mockups accepted on this issue',
    'A person accepted these as what the change should look like; read each before building the screen or call it shows.',
    ...mockupLines(rows, withheld),
  ].join('\n');
}

/** The requirement an issue delivers, read at its current revision with the baseline that pins it. */
export interface RequirementContextRow {
  requirementId: string;
  key: string;
  title: string;
  status: string;
  currentRevision: number | null;
  /** The state the head revision's row holds; anything but `current` is refused. */
  headState: string | null;
  tldr: string | null;
  goal: string | null;
  criteria: { id: string; code: string; body: string; form: string }[];
  baseline: {
    revision: number;
    seq: number;
    agreedAt: string;
    pins: RequirementPinRow[];
    mockups: MockupContextRow[];
  } | null;
  plannedRevision: number | null;
  plannedBaselineSeq: number | null;
  plan: string | null;
}

export interface LoadedRequirement {
  requirementId: string;
  key: string;
  revision: number;
  baselineRevision: number;
  plannedRevision: number | null;
  changedSincePlan: boolean;
  criteria: { id: string; code: string }[];
  pins: RequirementPinRow[];
  mockups: string[];
  text: string;
  chars: number;
  estTokens: number;
}

// cm:why one requirement's revision, criteria and pins; a requirement past it is refused whole, never cut, since a criterion left out is one the run would not build to
export const REQUIREMENT_CONTEXT_CAP_CHARS = 12_000;

/** A requirement the job cannot be given at its current revision, refused by name. */
const requirementRefusal = (code: ArtifactContextRefusalCode, key: string, reason: string) =>
  new RefusalError(
    [{ code, path: '', detail: `requirement ${key}: ${reason}` }],
    'ARTIFACT_CONTEXT_UNLOADABLE',
  );

// cm:guard a job loads only the current revision and the baseline agreed at it: a head that is not current, or a latest baseline pinning another revision, is refused REQUIREMENT_REVISION_NOT_CURRENT
export function requirementContext(
  row: RequirementContextRow | null,
  mockupsWithheld = false,
): LoadedRequirement | null {
  if (!row) return null;
  if (row.currentRevision === null || row.headState !== 'current') {
    throw requirementRefusal(
      'REQUIREMENT_REVISION_NOT_CURRENT',
      row.key,
      `its head is ${row.currentRevision === null ? 'not set' : `revision ${row.currentRevision} in state ${row.headState ?? 'unknown'}`}; a job is given only a current revision`,
    );
  }
  if (!row.baseline) {
    throw requirementRefusal(
      'REQUIREMENT_NOT_AGREED',
      row.key,
      `it is ${row.status} with no baseline; a job builds an agreed requirement`,
    );
  }
  if (row.baseline.revision !== row.currentRevision) {
    throw requirementRefusal(
      'REQUIREMENT_REVISION_NOT_CURRENT',
      row.key,
      `its latest baseline pins revision ${row.baseline.revision}, but the current revision is ${row.currentRevision}; the current revision is re-agreed before a job is given it`,
    );
  }
  const changed = changedSincePlan({ ...row, latestBaselineSeq: row.baseline.seq });
  const lines = [
    `## The requirement this issue delivers`,
    `${row.key} · ${row.title} — current revision ${row.currentRevision}, agreed (baseline r${row.baseline.revision}, ${row.baseline.agreedAt}).`,
  ];
  if (row.tldr) lines.push(row.tldr);
  if (row.goal) lines.push(`Goal: ${row.goal}`);
  lines.push(planLine(changed, row.plannedRevision, row.currentRevision));
  lines.push(
    '',
    'Business criteria (each issue criterion traces to one of these codes):',
    ...row.criteria.map(
      (c) =>
        `- ${c.code}${c.form === 'scenario' ? ' (scenario)' : ''}: ${c.body.replace(/\n/g, '\n  ')}`,
    ),
  );
  if (row.baseline.pins.length) {
    lines.push(
      '',
      'Pinned in the latest baseline (build to these revisions):',
      ...row.baseline.pins.map((p) =>
        p.workflowId
          ? `- design \`${p.flow ?? p.workflowId}\` at revision ${p.designRevision} — ${fetchLine(p.workflowId, p.designRevision)}`
          : `- contract \`${p.contractSlug}\`@${p.contractVersion} (provider ${p.providerProjectId})`,
      ),
    );
  }
  if (row.baseline.mockups.length) {
    lines.push(
      '',
      'Mockups pinned in the latest baseline (what the screens and calls should look like):',
      ...mockupLines(row.baseline.mockups, mockupsWithheld),
    );
  }
  const text = lines.join('\n');
  if (text.length > REQUIREMENT_CONTEXT_CAP_CHARS) {
    throw requirementRefusal(
      'ARTIFACT_CONTEXT_OVER_BUDGET',
      row.key,
      `its revision, criteria and pins take ${text.length} chars, over the ${REQUIREMENT_CONTEXT_CAP_CHARS}-char requirement budget`,
    );
  }
  return {
    requirementId: row.requirementId,
    key: row.key,
    revision: row.currentRevision,
    baselineRevision: row.baseline.revision,
    plannedRevision: row.plannedRevision,
    changedSincePlan: changed,
    criteria: row.criteria.map((c) => ({ id: c.id, code: c.code })),
    pins: row.baseline.pins,
    mockups: row.baseline.mockups.map((m) => m.key),
    text,
    chars: text.length,
    estTokens: estimateTokens(text),
  };
}

/** What the job's record keeps of the requirement it was given. */
export function requirementContextRecord(loaded: LoadedRequirement) {
  return {
    requirementId: loaded.requirementId,
    key: loaded.key,
    revision: loaded.revision,
    baselineRevision: loaded.baselineRevision,
    plannedRevision: loaded.plannedRevision,
    changedSincePlan: loaded.changedSincePlan,
    criteria: loaded.criteria,
    pins: loaded.pins,
    mockups: loaded.mockups,
    chars: loaded.chars,
    estTokens: loaded.estTokens,
  };
}
