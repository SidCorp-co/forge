// The one place a project's working agreements resolve (REQ-90, design `working-agreements` steps
// resolve and supply): Forge's defaults, the project's explicit changes and what is represented from
// its authoritative configuration, read for one task or for none. Pure: the page, the agents' map and
// a run's record all read this answer, so none of them can disagree with another.

import type {
  AgreementCondition,
  AgreementDetailView,
  AgreementProjectLayer,
  AgreementRevisionView,
  AgreementState,
  AgreementsView,
  AgreementTask,
  AgreementView,
} from '@forge/contracts/agreements';
import { AGREEMENT_STATES } from '@forge/contracts/agreements';
import { currentRevision, type ForgeAgreement } from './forge-defaults.js';

/** One project revision as the store holds it. */
export interface ProjectRevisionRow {
  slug: string;
  revision: number;
  change: 'override' | 'addition' | 'restore' | 'retire';
  name: string | null;
  rule: string | null;
  detail: string | null;
  condition: AgreementCondition | null;
  reason: string;
  baseRevision: number | null;
  actorUserId: string | null;
  actorName: string | null;
  at: Date;
}

/** An agreement written in another configuration, read from it as it stands (BC-4). */
export interface RepresentedAgreement {
  view: Omit<AgreementView, 'applies'>;
  history: AgreementRevisionView[];
}

/** Whether `condition` holds for `task`: one of its labels, or its category; null without a task. */
export function conditionApplies(
  condition: AgreementCondition | null,
  task: AgreementTask | null,
): boolean | null {
  if (!condition) return true;
  if (!task) return null;
  const labels = new Set(task.labels.map((l) => l.toLowerCase()));
  const byLabel = (condition.labels ?? []).some((l) => labels.has(l.toLowerCase()));
  const category = task.category?.toLowerCase() ?? null;
  const byCategory = (condition.categories ?? []).some((c) => c.toLowerCase() === category);
  return byLabel || byCategory;
}

/** How a condition reads in a map line and a refusal: `labels billing, payments`. */
export function conditionWords(condition: AgreementCondition | null): string | null {
  if (!condition) return null;
  const parts = [
    condition.labels ? `label ${condition.labels.join(' or ')}` : null,
    condition.categories ? `category ${condition.categories.join(' or ')}` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(', or ');
}

/** Each slug's revisions, newest first. */
function bySlug(rows: readonly ProjectRevisionRow[]): Map<string, ProjectRevisionRow[]> {
  const out = new Map<string, ProjectRevisionRow[]>();
  for (const r of [...rows].sort((a, b) => b.revision - a.revision)) {
    const list = out.get(r.slug) ?? [];
    list.push(r);
    out.set(r.slug, list);
  }
  return out;
}

const projectLayerOf = (r: ProjectRevisionRow): AgreementProjectLayer | null =>
  (r.change === 'override' || r.change === 'addition') && r.rule !== null
    ? {
        revision: r.revision,
        change: r.change,
        rule: r.rule,
        detail: r.detail,
        condition: r.condition,
        reason: r.reason,
        actor: { id: r.actorUserId, name: r.actorName },
        at: r.at.toISOString(),
        baseRevision: r.baseRevision,
      }
    : null;

const projectHistory = (rows: readonly ProjectRevisionRow[]): AgreementRevisionView[] =>
  rows.map((r) => ({
    layer: 'project',
    revision: r.revision,
    change: r.change,
    rule: r.rule,
    detail: r.detail,
    condition: r.condition,
    reason: r.reason,
    actor: { id: r.actorUserId, name: r.actorName },
    at: r.at.toISOString(),
  }));

const forgeHistory = (a: ForgeAgreement): AgreementRevisionView[] =>
  [...a.revisions].reverse().map((r) => ({
    layer: 'forge',
    revision: r.revision,
    change: 'default',
    rule: r.rule,
    detail: r.detail,
    condition: null,
    reason: r.reason,
    actor: null,
    at: new Date(`${r.at}T00:00:00Z`).toISOString(),
  }));

/** A Forge default on the project: inherited, overridden, or in conflict with a newer default. */
function forgeView(
  a: ForgeAgreement,
  rows: readonly ProjectRevisionRow[],
  task: AgreementTask | null,
  projectId: string,
): AgreementDetailView {
  const current = currentRevision(a);
  const forge = {
    revision: current.revision,
    rule: current.rule,
    detail: current.detail,
    source: a.source,
    restates: [...a.restates],
    at: new Date(`${current.at}T00:00:00Z`).toISOString(),
  };
  // a locked guarantee takes no project change: the door refuses one, so a row here was written past
  // it and is never read as in force
  const latest = rows[0];
  const project = !a.locked && latest ? projectLayerOf(latest) : null;
  const conflicted = project !== null && (project.baseRevision ?? 0) < current.revision;
  const state: AgreementState = !project ? 'inherited' : conflicted ? 'conflict' : 'overridden';
  const applies = project ? conditionApplies(project.condition, task) : true;
  // a conditional override governs only the tasks it names; any other task keeps the default
  const effective =
    project && applies !== false
      ? {
          rule: project.rule,
          detail: project.detail ?? forge.detail,
          condition: project.condition,
          from: 'project' as const,
          revision: `project@${project.revision}`,
        }
      : {
          rule: forge.rule,
          detail: forge.detail,
          condition: null,
          from: 'forge' as const,
          revision: `forge@${forge.revision}`,
        };
  return {
    slug: a.slug,
    name: a.name,
    locked: a.locked,
    authority: a.locked ? 'kernel' : 'agreement',
    door: a.locked ? null : `PUT /api/projects/${projectId}/agreements/${a.slug}`,
    state,
    forge,
    project,
    effective,
    conflict:
      conflicted && project
        ? {
            forge: { revision: forge.revision, rule: forge.rule },
            project: {
              revision: project.revision,
              baseRevision: project.baseRevision,
              rule: project.rule,
            },
            says: `Forge's default ${a.name} moved to revision ${forge.revision} after this project's change (revision ${project.revision}, written over default revision ${project.baseRevision ?? 'none'}). The project's change still holds; a project admin re-affirms it (PUT with the same rule) or restores the default.`,
          }
        : null,
    // a default always applies: to a task its project change's condition rules out, as the default
    // itself (BC-6); unresolved only where no task was given and the change is conditional
    applies: applies === null ? null : true,
    history: [...projectHistory(rows), ...forgeHistory(a)],
  };
}

/** A project's own agreement: the latest revision an addition, else retired and not current. */
function additionView(
  slug: string,
  rows: readonly ProjectRevisionRow[],
  task: AgreementTask | null,
  projectId: string,
): AgreementDetailView | null {
  const latest = rows[0];
  const project = latest ? projectLayerOf(latest) : null;
  if (!latest || !project || project.change !== 'addition') return null;
  return {
    slug,
    name: latest.name ?? slug,
    locked: false,
    authority: 'agreement',
    door: `PUT /api/projects/${projectId}/agreements/${slug}`,
    state: 'project_only',
    forge: null,
    project,
    effective: {
      rule: project.rule,
      detail: project.detail,
      condition: project.condition,
      from: 'project',
      revision: `project@${project.revision}`,
    },
    conflict: null,
    applies: conditionApplies(project.condition, task),
    history: projectHistory(rows),
  };
}

export interface ResolveInput {
  projectId: string;
  forge: readonly ForgeAgreement[];
  rows: readonly ProjectRevisionRow[];
  represented: readonly RepresentedAgreement[];
  task: AgreementTask | null;
}

/** Every current agreement of the project, each with its history; a retired one is not current. */
export function resolveAgreementDetails(input: ResolveInput): AgreementDetailView[] {
  const grouped = bySlug(input.rows);
  const forgeSlugs = new Set(input.forge.map((a) => a.slug));
  const forge = input.forge.map((a) =>
    forgeView(a, grouped.get(a.slug) ?? [], input.task, input.projectId),
  );
  const additions = [...grouped.entries()]
    .filter(([slug]) => !forgeSlugs.has(slug))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([slug, rows]) => {
      const v = additionView(slug, rows, input.task, input.projectId);
      return v ? [v] : [];
    });
  const represented = input.represented.map((r) => ({
    ...r.view,
    applies: conditionApplies(r.view.effective.condition, input.task),
    history: r.history,
  }));
  return [...forge, ...represented, ...additions];
}

/** The page's and the agents' answer: every current agreement, counted by state. */
export function resolveAgreements(input: ResolveInput): AgreementsView {
  const agreements = resolveAgreementDetails(input).map(({ history: _h, ...v }) => v);
  const counts = Object.fromEntries(AGREEMENT_STATES.map((s) => [s, 0])) as Record<
    AgreementState,
    number
  >;
  for (const a of agreements) counts[a.state] += 1;
  return {
    projectId: input.projectId,
    task: input.task,
    agreements,
    counts: { ...counts, locked: agreements.filter((a) => a.locked).length },
  };
}
