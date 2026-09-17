// Project-resolution layer for the Forge Facts registry. The registry's
// render() is pure; this module fetches the per-project inputs (currently the
// enabled status ladder from `agentConfig.pipelineConfig`) and produces the
// `FactRenderContext`, then renders facts into the shape the REST + MCP
// surfaces return. Lives apart from registry.ts so the registry stays free of
// DB/env coupling.

import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  type BindingRole,
  type DeployStage,
  type IssueStatus,
  type JobType,
  labels,
  projects,
  type ReleaseModel,
} from '../../db/schema.js';
import { integrationGuideSlug, loadOrgGuideProviders } from '../../guides/integration-guides.js';
import { grantHolds } from '../../integrations/agent-access.js';
import {
  type NormalizedEnvironments,
  normalizeEnvironments,
} from '../../projects/environments.js';
import { getIntegration } from '../../integrations/registry.js';
import { effectiveConfig, listBindingsForProject } from '../../integrations/store.js';
import {
  selectAllSlugsFromKnowledge,
  selectAlwaysInjectFromKnowledge,
  selectOnDemandSlugsFromKnowledge,
} from '../../knowledge/service.js';
import { logger } from '../../logger.js';
import {
  DEFAULT_NO_PROGRESS_ROUNDS,
  resolveNoProgressRounds,
} from '../../pipeline/reopen-policy.js';
import {
  type KnowledgeObligation,
  missingProjectKnowledge,
} from '../../projects/autonomous-contract.js';
import {
  ALWAYS_INJECT_MAX_CHARS,
  type RESERVED_PROJECT_FACT_KEYS,
  unreservedProjectKeyRefusal,
} from '../../projects/project-facts.js';
import { effectivePipelineStates } from './effective-ladder.js';
import {
  type FactRenderContext,
  FORGE_FACTS,
  type ForgeFact,
  getFact,
  type ProjectModuleFact,
} from './registry.js';

export interface ResolvedFact {
  id: string;
  title: string;
  category: ForgeFact['category'];
  tier: ForgeFact['tier'];
  scope: ForgeFact['scope'];
  namespace: ForgeFact['namespace'];
  appliesTo?: readonly JobType[];
  version: number;
  /** Project-resolved canonical text. */
  preview: string;
}

/** Resolves a `{{project:<key>}}` reference to its text, or undefined if unknown. */
export type ProjectVarResolver = (key: string) => string | undefined;

export interface ProjectFactInputs {
  /** Project happy-path ladder (enabled stages). */
  ladder: IssueStatus[];
  /** Raw project branch columns — lets a caller that already needs this read
   *  (e.g. the system-prompt builder) reuse it instead of reading `projects`
   *  a second time for the `## Project Config` block. */
  branches: { baseBranch: string | null; liveBranch: string | null; releaseModel: ReleaseModel };
  /** `pipelineConfig.reopenPolicy.noProgressRounds`, defaulted. Advisory —
   *  rendered into `## Project Config` for the agent to judge against. */
  noProgressRounds: number;
  /** Resolver for `{{project:<key>}}`. */
  project: ProjectVarResolver;
  /** Slugs of this project's `injection: 'on_demand'` knowledge entries — the
   *  fetch-on-demand index, which names the tool that holds them. */
  projectFactKeys: string[];
  /** This project's `injection: 'always'` knowledge entries: rendered VERBATIM
   *  into the preamble (like a mandatory ForgeFact), and excluded from the
   *  fetch-on-demand index. Paired with their full body, in order. */
  alwaysInjectFacts: Array<{ key: string; text: string }>;
  /** The knowledge store could not be read for this project. The index is then
   *  rendered as a named absence rather than left out: an agent told nothing is
   *  an agent that concludes this project has no guides. */
  factsUnavailable: boolean;
  /** Entries this project owes and has not written, computed from what it
   *  declares. Empty for a project that owes nothing — which is a different
   *  state from one that owes something and has not answered, and the reason
   *  the contract is computed rather than listed. */
  missingObligations: KnowledgeObligation[];
  /** The project's `kind='module'` labels (ISS-595). Empty for a project with
   *  no taxonomy, which is what keeps `module-attribution` out of its prompt. */
  modules: ProjectModuleFact[];
}

interface IntegrationRow {
  provider: string;
  role: BindingRole;
  stages: DeployStage[];
  lastHealthStatus: string | null;
  /** The provider's own extra line, built from its declaration — see `IntegrationUsage.renderExtra`. */
  extraLine?: string | null;
  /** ISS-1071 — does this binding reach an agent at all? Renders as the reason where it does not. */
  agentGranted?: boolean;
  /** Operator text for THIS project's binding, rendered verbatim. */
  instructions?: string | null;
  /** The caller's org authored a runtime guide for this provider. */
  hasOrgGuide?: boolean;
}

// cm:edge contract -> packages/core/src/integrations/types.ts — a provider's usage hint, its guide
// slug and its one extra line are fields on the declaration in `integrations/<provider>/adapter.ts`.
// Until ISS-1071 this comment pointed at a `usage-registry.ts` table and was only two thirds true:
// the sentry targets line was an `if (r.provider === 'sentry')` right here, so adding a provider
// that wanted one meant editing this renderer after all. That branch is gone and the claim now holds.
// cm:why one query, shared by the pipeline facts block and the chat preamble — a chat-only copy of the active-filter + sentry-target mapping would drift from what a job sees
export async function loadActiveIntegrationRows(
  projectId: string,
  orgId?: string | null,
): Promise<IntegrationRow[]> {
  // cm:guard both flags must hold — an inactive binding on an active connection (or vice versa) injects nothing at dispatch, so listing it here would advertise tools the agent will not receive
  const pairs = await listBindingsForProject(projectId);
  const active = pairs.filter((p) => p.binding.active && p.connection.active);
  if (active.length === 0) return [];

  // cm:why the guide lookup is skipped when nothing is connected — an unconnected project must not pay a query to discover guides it will never be pointed at
  const orgGuides = orgId ? await loadOrgGuideProviders(orgId) : new Set<string>();

  return active.map((p) => ({
    provider: p.binding.provider,
    role: p.binding.role,
    stages: (p.binding.stages ?? []) as DeployStage[],
    lastHealthStatus: p.connection.lastHealthStatus,
    instructions: p.binding.instructions ?? null,
    hasOrgGuide: orgGuides.has(p.binding.provider),
    extraLine: getIntegration(p.binding.provider)?.usage?.renderExtra?.(effectiveConfig(p)) ?? null,
    agentGranted: grantHolds(getIntegration(p.binding.provider), p.binding),
  }));
}

/** What a provider with nothing of its own to say renders. */
const GENERIC_USAGE = 'Project-specific integration.';

/** The sentence a connected-but-ungranted binding renders in place of its usage hint. */
function ungrantedNote(provider: string): string {
  return `connected, but agents on this project may NOT use it: agent access is off for this \`${provider}\` binding. You will not be given its tools; do not treat their absence as a credential or auth fault, and do not retry. An org owner or admin turns it on beside the integration under Settings → Integrations.`;
}

// cm:why indented as a markdown sub-block so multi-line operator text cannot break out of its bullet and read as a new top-level instruction to the agent
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function renderIntegrations(rows: IntegrationRow[]): string {
  if (rows.length === 0) {
    return '## Project integrations\nNo external integrations are connected to this project.';
  }
  const lines = rows.map((r) => {
    const decl = getIntegration(r.provider);
    const hint = decl?.usage?.hint ?? GENERIC_USAGE;
    const health = r.lastHealthStatus ? ` (health: ${r.lastHealthStatus})` : '';
    // cm:why the org's runtime guide WINS over the seeded slug — an org authors one precisely to correct or replace the shipped default, so pointing at the default would send the agent to the text they overrode
    const guideSlug = r.hasOrgGuide ? integrationGuideSlug(r.provider) : decl?.usage?.guideSlug;
    const guidePointer = guideSlug ? ` Full guide: \`forge_guide get ${guideSlug}\`.` : '';
    // cm:why the bracket says `service` or the stages rather than an environment: it used to print
    // `[prod]` for every sentry, rocketchat, github and postman binding in the fleet, which was the
    // filler value the column forced them to carry and told the agent nothing.
    const scope = r.role === 'service' ? 'service' : r.stages.join('+') || 'deploy';
    // ISS-1038 — connected is not reachable. A binding no agent may use used to render the same
    // "here is how to use it" line as one an agent could, so a session was told to reach for tools
    // it would never be given and read their absence as a credential fault. The bullet now says
    // which it is, and where the switch is, INSTEAD of the usage hint — not beside it, because a
    // line telling an agent how to use something it cannot use is the thing being removed.
    const body = r.agentGranted === false ? ungrantedNote(r.provider) : `${hint}${guidePointer}`;
    const bullet = `- **${r.provider}** [${scope}]${health} — ${body}`;
    const extra: string[] = [];
    if (r.agentGranted !== false && r.extraLine) extra.push(r.extraLine);
    // cm:guard operator text, rendered VERBATIM and last so it is the final word for this provider — never summarise, reorder or truncate it here
    const instructions = r.instructions?.trim();
    if (instructions) {
      extra.push(
        `  - Project-specific instructions for **${r.provider}** (follow these over the general guide where they conflict):\n${indentBlock(instructions)}`,
      );
    }
    return extra.length > 0 ? `${bullet}\n${extra.join('\n')}` : bullet;
  });
  return `## Project integrations\nConnected integrations and how to use them:\n${lines.join('\n')}`;
}

/**
 * `{{project:<key>}}` resolver. Every key it answers derives from a first-class
 * project column or from `environments`; there is no author-owned map behind it
 * any more. A key outside the reserved set resolves to a refusal naming the
 * knowledge store, NOT to `undefined` — an unresolved reference renders as the
 * empty string, so returning nothing would silently delete a sentence from the
 * prompt of every project whose skill body still carries one, and no gate in
 * this repository can see a skill body in another. That is the same decision
 * `production-branch` carries above it. Pure.
 */
export function makeProjectResolver(src: {
  baseBranch: string | null;
  liveBranch: string | null;
  releaseModel: ReleaseModel;
  repoPath: string | null;
  environments: NormalizedEnvironments;
  integrations: IntegrationRow[];
}): ProjectVarResolver {
  const reserved: Record<(typeof RESERVED_PROJECT_FACT_KEYS)[number], () => string | undefined> = {
    'base-branch': () => src.baseBranch ?? undefined,
    // cm:guard resolves ONLY under `promote`, for the same reason `formatProjectConfig` prints the
    // line only there: 25 of 32 fleet projects carry a `live_branch` that nothing promotes to, and a
    // skill body splicing one in would state a branch as this project's release target when the
    // project declares it has no release step.
    'live-branch': () =>
      src.releaseModel === 'promote' ? (src.liveBranch ?? undefined) : undefined,
    // cm:guard a REFUSAL and not `undefined`, which is the whole point: an unresolved
    // `{{project:<key>}}` renders as empty, so leaving this key out would silently delete a sentence
    // from the prompt of every project whose skill body still uses it — and no gate in this repo can
    // see a skill body in another one. A loud break beats a silent substitution (ISS-1046).
    'production-branch': () =>
      '⚠️ `{{project:production-branch}}` was retired when a project gained a declared release model (ISS-1046). Use `{{project:live-branch}}`, which resolves only where the project declares `releaseModel: promote`. Update this skill body.',
    'repo-path': () => src.repoPath ?? undefined,
    // cm:guard BOTH sides, each labelled, because after ISS-1069 a project has two and an agent
    // handed a bare list cannot tell which address it is allowed to write to. A one-box project
    // renders only the live line; `preview: null` is that project saying it has no other side,
    // and rendering nothing at all for it would have been the old shape's answer.
    'test-urls': () => {
      const lines = [
        ...(src.environments.preview
          ? [
              ...(src.environments.preview.url ? [`- Preview: ${src.environments.preview.url}`] : []),
              ...(src.environments.preview.apiUrl
                ? [`- Preview API: ${src.environments.preview.apiUrl}`]
                : []),
              ...src.environments.preview.urls.map(
                (u) => `- Preview${u.label ? ` (${u.label})` : ''}: ${u.url}`,
              ),
            ]
          : []),
        ...(src.environments.live.url ? [`- Live: ${src.environments.live.url}`] : []),
        ...(src.environments.live.apiUrl ? [`- Live API: ${src.environments.live.apiUrl}`] : []),
      ];
      return lines.length > 0 ? lines.join('\n') : undefined;
    },
    // cm:guard a POINTER and never the value: this string is spliced VERBATIM into the
    // device-installed SKILL.md, so whatever it says lands on disk.
    'test-creds': () =>
      'Fetch test credentials at runtime via `forge_projects.get` → `environments.testCredentials` (never hardcode secrets).',
    // cm:guard the KEY stays `test-notes` though the FIELD is now `limits`. Skill bodies in other
    // repositories splice this name, an unresolved `{{project:<key>}}` renders as the empty string,
    // and no gate in this repo can see a skill body in another one — so renaming the key would
    // delete a sentence from an agent's prompt with nobody told. `production-branch` above is the
    // same decision (ISS-1046, ISS-1069).
    'test-notes': () => src.environments.limits ?? undefined,
    integrations: () => renderIntegrations(src.integrations),
  };
  return (key) =>
    key in reserved ? reserved[key as keyof typeof reserved]() : unreservedProjectKeyRefusal(key);
}

/**
 * The project's module taxonomy, flattened to names — the one input `module-attribution` gates on.
 *
 * Parent comes back as a NAME because the only consumer writes it into a system prompt, where an
 * id is noise an agent cannot act on: `forge_issues` resolves a module by name as well as by uuid.
 */
// cm:guard an EMPTY array is what keeps the `module-attribution` fact out of a taxonomy-less project's prompt, so this must stay a plain read with no placeholder row and no fallback list
// cm:why read here rather than through `labels/module-service.ts`, which owns modules: that import is an EIGHTH module edge out of this file and `no-coordinator-blob` freezes it at seven. The invariants module-service holds are all about WRITES; a list has none to hold.
export async function loadProjectModules(projectId: string): Promise<ProjectModuleFact[]> {
  const parents = alias(labels, 'parent_labels');
  const rows = await db
    .select({ name: labels.name, parentName: parents.name })
    .from(labels)
    .leftJoin(parents, eq(labels.parentId, parents.id))
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')))
    .orderBy(labels.name);
  return rows.map((r) => ({ name: r.name, parentName: r.parentName ?? null }));
}

/** Load the per-project inputs for fact resolution: the status ladder, the
 *  `{{project:}}` resolver (project columns + environments + connected
 *  integrations) and this project's knowledge entries. */
export async function loadProjectFactInputs(projectId: string): Promise<ProjectFactInputs> {
  let states: Record<string, { enabled?: boolean } | undefined> = {};
  let baseBranch: string | null = null;
  let liveBranch: string | null = null;
  let releaseModel: ReleaseModel = 'none';
  let repoPath: string | null = null;
  let environments: NormalizedEnvironments = normalizeEnvironments(null);
  let integrations: IntegrationRow[] = [];
  let noProgressRounds = DEFAULT_NO_PROGRESS_ROUNDS;
  let modules: ProjectModuleFact[] = [];
  let alwaysInjectFacts: Array<{ key: string; text: string }> = [];
  let projectFactKeys: string[] = [];
  let factsUnavailable = false;
  let missingObligations: KnowledgeObligation[] = [];
  let repoUrl: string | null = null;
  try {
    const [row] = await db
      .select({
        agentConfig: projects.agentConfig,
        environments: projects.environments,
        repoPath: projects.repoPath,
        repoUrl: projects.repoUrl,
        baseBranch: projects.baseBranch,
        liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
        orgId: projects.orgId,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac =
      (row?.agentConfig as {
        pipelineConfig?: { states?: typeof states };
      } | null) ?? null;
    states = ac?.pipelineConfig?.states ?? {};
    noProgressRounds = resolveNoProgressRounds(row?.agentConfig);
    environments = normalizeEnvironments(row?.environments);
    baseBranch = row?.baseBranch ?? null;
    liveBranch = row?.liveBranch ?? null;
    releaseModel = row?.releaseModel ?? 'none';
    repoPath = row?.repoPath ?? null;
    repoUrl = row?.repoUrl ?? null;

    integrations = await loadActiveIntegrationRows(projectId, row?.orgId ?? null);
    modules = await loadProjectModules(projectId);
  } catch {
    // defaults → full ladder, empty {{project:}} resolver
  }

  // The knowledge store is the only source of project prose. There is no second
  // one to fall back to, so a failure here is reported into the prompt rather
  // than swallowed: this runs at dispatch, and throwing would fail the job
  // instead of the read, while rendering nothing would tell the agent this
  // project has no guides — which is a different claim from "could not look".
  try {
    let heldSlugs: string[];
    [alwaysInjectFacts, projectFactKeys, heldSlugs] = await Promise.all([
      selectAlwaysInjectFromKnowledge(projectId),
      selectOnDemandSlugsFromKnowledge(projectId),
      selectAllSlugsFromKnowledge(projectId),
    ]);
    // cm:edge contract -> packages/core/src/projects/autonomous-contract.ts — the SAME function `release-batch/readiness.ts` asks. Two lists is how the contract and the readiness gaps came to disagree about what a project owes, and this is the second reader that makes one list load-bearing rather than tidy.
    missingObligations = missingProjectKnowledge({ repoPath, repoUrl, releaseModel }, heldSlugs);
  } catch (err) {
    factsUnavailable = true;
    alwaysInjectFacts = [];
    projectFactKeys = [];
    missingObligations = [];
    logger.error(
      { err: (err as Error).message, projectId },
      'prompt.facts: knowledge store unreadable, the prompt says so in place of the guide index',
    );
  }

  return {
    ladder: effectivePipelineStates(states),
    branches: { baseBranch, liveBranch, releaseModel },
    noProgressRounds,
    project: makeProjectResolver({
      baseBranch,
      liveBranch,
      releaseModel,
      repoPath,
      environments,
      integrations,
    }),
    projectFactKeys,
    alwaysInjectFacts,
    factsUnavailable,
    missingObligations,
    modules,
  };
}

/** Demote `##` fact headers one level so they nest under `## Forge context`
 *  instead of rendering as its siblings. Standalone surfaces (REST/MCP
 *  preview) keep the facts' own `##` headers. */
function demoteHeadings(text: string): string {
  return text.replace(/^## /gm, '### ');
}

/**
 * Pure renderer behind `renderStageFactsBlock` — exported for unit tests.
 *
 * Inlines ONLY what steers mandatory behaviour: the stage-applicable
 * contextual facts (status ladder, enums, protocols) plus the connected
 * integrations (tool-routing info). Everything an agent can fetch through a
 * Forge tool is pointed-to, not inlined — the project's `on_demand` knowledge
 * entries render as a slug index the agent fetches through `forge_knowledge`,
 * which is the tool that holds them, and test URLs/creds are already covered by
 * the Project Context pointer to `forge_projects.get`.
 */
export function renderStageFactsText(
  inputs: ProjectFactInputs,
  projectId: string,
  stage: JobType,
): string {
  const ctx: FactRenderContext = {
    projectId,
    stage,
    ladder: inputs.ladder,
    modules: inputs.modules,
  };

  // cm:guard `relevant` is asked LAST and its absence means yes, so a fact that does not opt in renders exactly as it did before the predicate existed — the property the pinned-heading test in `resolve.test.ts` rests on
  const forgeText = FORGE_FACTS.filter(
    (f) =>
      f.tier === 'contextual' &&
      (!f.appliesTo || f.appliesTo.includes(stage)) &&
      (f.relevant?.(ctx) ?? true),
  )
    .map((f) => demoteHeadings(f.render(ctx)))
    .join('\n\n');

  const projectParts: string[] = [];

  // cm:guard the cap decides only whether a warning is logged: every flagged body renders whatever the summed size, because a truncated hard rule is worse than a warned-but-present one.
  // cm:why "Follow them exactly." stays, and ISS-936 is where that was decided rather than overlooked. Nothing verifies the rule was obeyed, and the honest sentence about that (`ALWAYS_INJECT_GUARANTEE_NOTE`) is owed to the OWNER who sets the flag, on the surfaces that offer it. Putting it here instead tells the agent, inside the rule, that ignoring the rule costs nothing — which converts an unverified rule into an ignored one.
  // cm:edge contract -> packages/core/src/projects/project-facts.ts — `ALWAYS_INJECT_GUARANTEE_NOTE` describes THIS render to an owner; a change to what is guaranteed here has to move that sentence
  const alwaysInject = inputs.alwaysInjectFacts;
  const alwaysInjectKeys = new Set(alwaysInject.map((f) => f.key));
  if (alwaysInject.length > 0) {
    const totalChars = alwaysInject.reduce((sum, f) => sum + f.text.length, 0);
    if (totalChars > ALWAYS_INJECT_MAX_CHARS) {
      logger.warn(
        {
          projectId,
          stage,
          totalChars,
          maxChars: ALWAYS_INJECT_MAX_CHARS,
          keys: alwaysInject.map((f) => f.key),
        },
        'always-inject knowledge entries exceed the char budget — every prompt for this project carries the overflow',
      );
    }
    projectParts.push(
      [
        '### Project rules (always applied)',
        'Hard rules for this project — always-injected by the project owner. Follow them exactly.',
        ...alwaysInject.map((f) => `#### ${f.key}\n${f.text}`),
      ].join('\n\n'),
    );
  }

  const integrations = inputs.project('integrations');
  if (integrations) projectParts.push(demoteHeadings(integrations));

  // Fetch-on-demand index excludes always-inject slugs — their bodies are
  // already inlined above, so listing them again as "fetch this" is noise.
  //
  // An unreadable store is said rather than left out: the two render differently
  // on purpose, because an agent shown no index concludes this project has no
  // guides, which is a claim nobody made.
  if (inputs.factsUnavailable) {
    projectParts.push(
      [
        '### Project guides (fetch on demand)',
        "This project's knowledge store could not be read while this prompt was built, so this index is missing rather than empty. Do not conclude that this project has no guides: list them yourself with `forge_knowledge` (action `list`) before deciding anything rests on their absence.",
      ].join('\n'),
    );
  } else {
    const indexKeys = inputs.projectFactKeys.filter((key) => !alwaysInjectKeys.has(key));
    if (indexKeys.length > 0) {
      projectParts.push(
        [
          '### Project guides (fetch on demand)',
          'Author-maintained guides exist for this project. When the task needs one, fetch its text via `forge_knowledge` (action `get` + slug) — do NOT guess its contents:',
          ...indexKeys.map((key) => `- ${key}`),
        ].join('\n'),
      );
    }
  }

  // What this project owes and has not written. Rendered only when there is
  // something owed: a project with no repository and no release model owes
  // nothing, and a block saying so on every prompt is a line that never varies.
  if (inputs.missingObligations.length > 0) {
    projectParts.push(
      [
        '### Undeclared project knowledge',
        'This project owes the entries below and none of them exists yet. Nothing here blocks you — but a step that needs one has nothing to read, so say so rather than inventing the answer, and offer the text to whoever owns the project:',
        ...inputs.missingObligations.map(
          (o) => `- \`${o.slug}\` — ${o.role} (owed because ${o.because})`,
        ),
      ].join('\n'),
    );
  }

  return ['## Forge context', forgeText, ...projectParts].filter((s) => s.length > 0).join('\n\n');
}

/**
 * Render the `## Forge context` block injected into the system prompt for a
 * pipeline `stage` (prompt/system.ts) — the project-resolved contextual facts a
 * skill at this stage needs, so skill bodies stay pure business logic.
 * Returns '' for a non-pipeline stage. See `renderStageFactsText` for what is
 * inlined vs pointed-to.
 */
export async function renderStageFactsBlock(
  projectId: string,
  stage: JobType | null,
): Promise<string> {
  if (!stage) return '';
  const inputs = await loadProjectFactInputs(projectId);
  return renderStageFactsText(inputs, projectId, stage);
}

export async function buildFactContext(
  projectId: string,
  stage?: JobType | null,
): Promise<FactRenderContext> {
  const { ladder, modules } = await loadProjectFactInputs(projectId);
  return { projectId, stage: stage ?? null, ladder, modules };
}

function toResolved(fact: ForgeFact, ctx: FactRenderContext): ResolvedFact {
  const base: ResolvedFact = {
    id: fact.id,
    title: fact.title,
    category: fact.category,
    tier: fact.tier,
    scope: fact.scope,
    namespace: fact.namespace,
    version: fact.version,
    preview: fact.render(ctx),
  };
  return fact.appliesTo ? { ...base, appliesTo: fact.appliesTo } : base;
}

export async function listResolvedFacts(
  projectId: string,
  stage?: JobType | null,
): Promise<ResolvedFact[]> {
  const ctx = await buildFactContext(projectId, stage);
  return FORGE_FACTS.map((f) => toResolved(f, ctx));
}

export async function getResolvedFact(
  projectId: string,
  id: string,
  stage?: JobType | null,
): Promise<ResolvedFact | undefined> {
  const fact = getFact(id);
  if (!fact) return undefined;
  const ctx = await buildFactContext(projectId, stage);
  return toResolved(fact, ctx);
}
