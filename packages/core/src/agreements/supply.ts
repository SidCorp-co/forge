// What an agent is handed of the project's working agreements (REQ-90 design step supply): a short
// map, one line per agreement that applies to its task, each the effective rule only. A default a
// project overrode, a retired revision and an agreement whose condition the task does not meet are
// never offered as current; detail is fetched on demand. The orientation a box writes and every
// pipeline preamble carry this one block, so a fresh session and a dispatched job read the same map.

import type { AgreementsView, AgreementView } from '@forge/contracts/agreements';
import type { AgreementFound } from '../run-context/index.js';
import { conditionWords } from './resolve.js';

/** The agreements a map hands the agent: every one but those the task's conditions rule out. */
export function suppliedOf(view: AgreementsView): AgreementView[] {
  return view.agreements.filter((a) => a.applies !== false);
}

function line(a: AgreementView): string {
  const when = conditionWords(a.effective.condition);
  const marks = [
    a.locked ? 'locked' : null,
    a.state === 'overridden' || a.state === 'conflict' ? 'project' : null,
    a.state === 'project_only' ? 'project only' : null,
  ].filter((m): m is string => m !== null);
  const tag = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  // a conditional change with no task to judge it by: the default holds outside its condition
  const rule =
    when && a.applies === null && a.forge && a.effective.from === 'project'
      ? `${a.forge.rule} When ${when}: ${a.effective.rule}`
      : when && a.applies === null
        ? `When ${when}: ${a.effective.rule}`
        : a.effective.rule;
  const conflict =
    a.state === 'conflict'
      ? " Forge's default has moved since; this project's change holds until its admin re-affirms or restores it."
      : '';
  return `- **${a.name}**${tag}: ${rule}${conflict} \`${a.slug}\``;
}

/**
 * The map, or null where nothing applies. `depth` is the heading level. The detail of any agreement
 * is one read away, and the line names its slug for it.
 */
export function agreementsMapText(
  view: AgreementsView,
  depth: 2 | 3,
  projectId: string,
): string | null {
  const supplied = suppliedOf(view);
  if (supplied.length === 0) return null;
  const others = view.agreements.length - supplied.length;
  return [
    `${'#'.repeat(depth)} Working agreements`,
    `How work runs here: Forge's defaults with this project's changes${view.task ? ', resolved for this task' : ''}. Each line is in force; detail on demand: \`GET /api/projects/${projectId}/agreements/<slug>\`.`,
    supplied.map(line).join('\n'),
    others > 0 ? `${others} more apply only to other tasks.` : null,
  ]
    .filter((p): p is string => p !== null)
    .join('\n\n');
}

/** What the map handed a run, for its record: each agreement's slug and the revision in force. */
export function agreementsCarried(view: AgreementsView): AgreementFound[] {
  return suppliedOf(view).map((a) => ({ slug: a.slug, revision: a.effective.revision }));
}

/**
 * The always-on rules each agreement restates, by rule slug: a rule whose text an agreement already
 * states is carried as that agreement's detail, never as a second instruction beside it.
 */
export function restatedRules(view: AgreementsView): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  // the agreement named as the rule is its one source; another that cites it only leans on it
  for (const a of view.agreements)
    if (a.forge?.restates.some((l) => l.ref === a.slug)) out.set(a.slug, a.name);
  for (const a of view.agreements) {
    for (const link of a.forge?.restates ?? []) {
      if (link.kind === 'rule' && !out.has(link.ref)) out.set(link.ref, a.name);
    }
  }
  return out;
}
