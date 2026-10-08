// What each claimed issue of a storefront release landed, in the kinds the provider can attest: the
// storefront draft its newest verdict judged on each workflow, and every workflow, route, page,
// theme and store setting its mark names (`storefrontArtifactOf`). An issue whose mark is only the
// approval of a design revision, and that is not the build of a workflow (`workflow_builds`, as
// migration 0450 tells them apart), deployed nothing: its approval record is what proves it.

import {
  designLandingRef,
  type LandingArtifact,
  STOREFRONT_ARTIFACT_GRAMMAR,
  type StorefrontArtifact,
  type StorefrontThemeFile,
  storefrontArtifactOf,
  storefrontLandingClauses,
} from '@forge/contracts/landing-artifacts';
import type { CriterionWithVerdict } from '../issues/index.js';

/** One claimed issue as the verification reads it: its verdicts and its merged mark. */
export interface RosterIssue {
  id: string;
  key: string;
  criteria: readonly CriterionWithVerdict[];
  /** When the mark was stamped: the time a landing it names was recorded. */
  mergedAt: string | null;
  landing: string | null;
  artifacts: readonly LandingArtifact[] | null;
  /** Linked as the build of a workflow: an approval on it is evidence, never its landing. */
  builds: boolean;
  /** Artifacts other issues' marks say this issue carries: its landing inherits them. */
  inherited: ReadonlyArray<{ from: string; mergedAt: string | null; artifact: LandingArtifact }>;
}

interface Landed {
  issue: string;
  /** The artifact as the mark (or the verdict) wrote it. */
  ref: string;
  /** When it was judged (a verdict) or recorded (a mark); null where the mark records no time. */
  landedAt: string | null;
  removed: boolean;
}

export interface WorkflowLanding extends Landed {
  workflowId: string;
  /** The graph it landed at, whole (a verdict) or a prefix of at least 8 hex (a mark); null where unnamed. */
  graph: string | null;
  from: 'verdict' | 'mark';
}

export interface KeyedLanding extends Landed {
  id: string;
}

export interface ThemeLanding extends Landed {
  id: string;
  files: StorefrontThemeFile[];
}

export interface SettingLanding extends Landed {
  key: string;
  value: string;
}

/** An issue proved by the approval of the design revisions its mark names. */
export interface DesignLanding {
  issue: string;
  refs: string[];
  /** The commits its verdicts judged, which its mark names nothing of. */
  judgedCommits: string[];
}

/** A landing what the provider serves does not carry, or an issue that names nothing it can attest. */
/** An artifact a mark says another issue's own release ships (`carriedBy`, the carrier's key). */
export interface CarriedLanding {
  issue: string;
  ref: string;
  carrier: string;
}

export interface ProviderMismatch {
  issue: string;
  kind: StorefrontArtifact['kind'] | 'design' | 'carried' | null;
  /** The workflow, route, page, theme or setting it landed, or the design revision. */
  ref: string | null;
  workflow: string | null;
  workflowCode: string | null;
  landed: string | null;
  served: string | null;
  why: string;
}

export interface Landings {
  workflows: WorkflowLanding[];
  routes: KeyedLanding[];
  pages: KeyedLanding[];
  themes: ThemeLanding[];
  settings: SettingLanding[];
  design: DesignLanding[];
  carried: CarriedLanding[];
  /** What a mark names that the provider reports no state for: a table, test rows, a domain. */
  unattested: Array<{ issue: string; ref: string }>;
  unprovable: ProviderMismatch[];
}

const DESIGN_REF = /^([^\s@()]+)@rev(\d+)\b/;

/** A design ref as `<flow>@rev<n>`, read for its flow and revision; null where it is not one. */
export function designRefParts(ref: string): { flow: string; revision: number } | null {
  const m = DESIGN_REF.exec(ref.trim());
  return m ? { flow: m[1] as string, revision: Number(m[2]) } : null;
}

/** The newest storefront draft each workflow's verdicts judged, latest verdict per criterion. */
function verdictWorkflows(issue: RosterIssue): WorkflowLanding[] {
  const byWorkflow = new Map<string, WorkflowLanding>();
  for (const c of issue.criteria) {
    const v = c.latest;
    if (v?.identityKind !== 'storefront_draft') continue;
    if (!v.storefrontWorkflowId || !v.storefrontDraftVersion) continue;
    const held = byWorkflow.get(v.storefrontWorkflowId);
    if (held && Date.parse(held.landedAt ?? '') >= Date.parse(v.createdAt)) continue;
    const graph = v.storefrontDraftVersion.trim();
    byWorkflow.set(v.storefrontWorkflowId, {
      issue: issue.key,
      ref: `workflow ${v.storefrontWorkflowId} @${graph}`,
      landedAt: v.createdAt,
      removed: false,
      workflowId: v.storefrontWorkflowId,
      graph,
      from: 'verdict',
    });
  }
  return [...byWorkflow.values()];
}

/** What a mark names: its artifacts, else its landing read clause by clause. */
interface Named {
  ref: string;
  artifact: StorefrontArtifact | null;
  design: boolean;
  removed: boolean;
  carriedBy: string | null;
}

const namedOf = (a: LandingArtifact): Named => ({
  ref: a.ref,
  artifact: a.surface === 'design' ? null : storefrontArtifactOf(a.ref),
  design: a.surface === 'design',
  removed: a.change === 'removed',
  carriedBy: a.carriedBy ?? null,
});

/** What a mark names: its artifacts, else its landing read clause by clause. */
function markArtifacts(issue: RosterIssue): Named[] {
  if (issue.artifacts && issue.artifacts.length > 0) return issue.artifacts.map(namedOf);
  const design = designLandingRef(issue.landing);
  if (design) {
    return [{ ref: design, artifact: null, design: true, removed: false, carriedBy: null }];
  }
  return storefrontLandingClauses(issue.landing).map((c) => ({
    ...c,
    design: false,
    removed: false,
    carriedBy: null,
  }));
}

/** What other issues' marks say this one carries, as its own landings recorded when they were. */
function inheritedArtifacts(
  issue: RosterIssue,
): Array<Named & { landedAt: string | null; inherited: boolean }> {
  return issue.inherited.flatMap(({ from, mergedAt, artifact }) =>
    artifact.surface === 'design'
      ? []
      : [
          {
            ...namedOf(artifact),
            ref: `${artifact.ref} (carried from ${from})`,
            carriedBy: null,
            landedAt: mergedAt,
            inherited: true,
          },
        ],
  );
}

function unprovableWhy(issue: RosterIssue, named: string[], label: string): string {
  const kinds = [...new Set(issue.criteria.map((c) => c.latest?.identityKind ?? 'unjudged'))];
  const judged =
    issue.criteria.length === 0
      ? 'it has no criterion'
      : `its verdicts name no storefront draft (${kinds.join(', ')})`;
  const mark =
    issue.mergedAt == null
      ? 'it carries no merged mark'
      : named.length === 0
        ? 'its mark names no artifact'
        : `its mark names only what ${label} reports no state for (${named.slice(0, 3).join('; ')}${named.length > 3 ? `; and ${named.length - 3} more` : ''})`;
  return `${issue.key} names nothing ${label} can attest: ${judged}, and ${mark}. A storefront landing names what it changed as ${STOREFRONT_ARTIFACT_GRAMMAR}`;
}

const blank = (issue: string, why: string): ProviderMismatch => ({
  issue,
  kind: null,
  ref: null,
  workflow: null,
  workflowCode: null,
  landed: null,
  served: null,
  why,
});

/** Every claimed issue's landings by kind, the design-only issues, and those naming nothing to attest. */
export function landingsOf(roster: readonly RosterIssue[], label = 'the provider'): Landings {
  const out: Landings = {
    workflows: [],
    routes: [],
    pages: [],
    themes: [],
    settings: [],
    design: [],
    carried: [],
    unattested: [],
    unprovable: [],
  };
  for (const issue of roster) {
    const named = markArtifacts(issue);
    // a workflow the mark says another issue carries is that issue's to ship, verdict or not
    const carriedWorkflows = new Set(
      named.flatMap((n) => (n.carriedBy && n.artifact?.kind === 'workflow' ? [n.artifact.id] : [])),
    );
    const fromVerdicts = verdictWorkflows(issue).filter((w) => !carriedWorkflows.has(w.workflowId));
    const seen = new Set(fromVerdicts.map((w) => w.workflowId));
    out.workflows.push(...fromVerdicts);
    let attested = fromVerdicts.length;
    const designRefs: string[] = [];
    const unattested: string[] = [];
    const own = named.map((n) => ({ ...n, landedAt: issue.mergedAt, inherited: false }));
    for (const { ref, artifact, design, removed, carriedBy, landedAt, inherited } of [
      ...own,
      ...inheritedArtifacts(issue),
    ]) {
      if (carriedBy) {
        out.carried.push({ issue: issue.key, ref, carrier: carriedBy });
        attested += 1;
        continue;
      }
      if (design) {
        designRefs.push(ref);
        continue;
      }
      if (!artifact) {
        unattested.push(ref);
        continue;
      }
      const base = { issue: issue.key, ref, landedAt, removed };
      switch (artifact.kind) {
        case 'workflow':
          // another issue's landing it carries is its own landing, judged whatever this one names
          if (seen.has(artifact.id) && !inherited) break;
          seen.add(artifact.id);
          out.workflows.push({
            ...base,
            workflowId: artifact.id,
            graph: artifact.graph,
            from: 'mark',
          });
          break;
        case 'route':
          out.routes.push({ ...base, id: artifact.id });
          break;
        case 'page':
          out.pages.push({ ...base, id: artifact.id });
          break;
        case 'theme':
          out.themes.push({ ...base, id: artifact.id, files: artifact.files });
          break;
        case 'setting':
          out.settings.push({ ...base, key: artifact.key, value: artifact.value });
          break;
      }
      attested += 1;
    }
    out.unattested.push(...unattested.map((ref) => ({ issue: issue.key, ref })));
    if (attested > 0) continue;
    const designOnly =
      designRefs.length > 0 && unattested.length === 0 && named.every((n) => n.design);
    if (designOnly && !issue.builds) {
      const commits = issue.criteria
        .map((c) => (c.latest?.identityKind === 'commit' ? c.latest.commitSha : null))
        .filter((s): s is string => !!s);
      out.design.push({ issue: issue.key, refs: designRefs, judgedCommits: [...new Set(commits)] });
      continue;
    }
    if (designOnly) {
      out.unprovable.push(
        blank(
          issue.key,
          `${issue.key} is linked as the build of a workflow, so the approval of design ${designRefs.join(', ')} is evidence on it, never its landing, and it names nothing ${label} can attest`,
        ),
      );
      continue;
    }
    out.unprovable.push(blank(issue.key, unprovableWhy(issue, unattested, label)));
  }
  return out;
}
