// A project rule the owner rules in his room, written or amended in his name (ISS-1357, FB-770: his
// ruling made there had no act to become the rule a master asks him to change, so masters refused it
// as relayed). It runs the knowledge door's own write (`knowledge/upsert.ts:upsertKnowledgeEntry`)
// under the grant that door's PUT asks, project.write, checked on his own account, so one who may not
// write rules is refused by that check's own name. The rule reads as his: authored by a person, his
// account and message on `metadata.ruledBy`, and his message, quoted, as what it rests on (`source`).
// An amend keeps the one row the slug holds and each field he did not change.

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import {
  getKnowledgeEntry,
  upsertKnowledgeEntry,
  upsertKnowledgeInputSchema,
} from '../knowledge/index.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';

/** Who ruled it and where: his Forge account, his chat account and the message the rule rests on. */
export interface RuledBy {
  userId: string;
  account: string;
  message: string;
  thread: string;
}

/** The request path a knowledge-input field is sent at on this act. */
const pathOf = (field: PropertyKey | undefined): string =>
  field === 'slug' ? '/item' : `/rule/${String(field ?? '')}`;

/** Write or amend the rule `input.item` names, as `at.userId`, citing his message in `source`. */
export async function writeOwnerRule(
  input: SupportForgeActRequest,
  cite: { source: string; ruledBy: RuledBy },
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const refused = await permissionRefusalFor(
    actorFor(at.userId),
    'project.write',
    projectResource(at.projectId),
    'writing a project rule',
  );
  if (refused) {
    return { ok: false, refusals: [{ code: refused.code, path: '/act', detail: refused.detail }] };
  }
  const rule = input.rule;
  if (!rule) throw new Error('owner-rule-act: rule.write reached its write with no rule');
  const held = await getKnowledgeEntry(at.projectId, input.item);
  if (held && held.kind !== 'rule') {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/item',
      `${input.item} is a ${held.kind} of this project, not a rule, and rule.write never turns one into a rule: name a rule's slug, or a new one. Nothing was done`,
    );
  }
  if (!held && !rule.title) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/rule/title',
      `${input.item} is a new rule, so it takes a title (an amend keeps the one it has). Nothing was done`,
    );
  }
  const kept = (held?.metadata ?? {}) as Record<string, unknown>;
  const parsed = upsertKnowledgeInputSchema.safeParse({
    projectId: at.projectId,
    slug: input.item,
    title: rule.title ?? held?.title,
    body: rule.body,
    kind: 'rule',
    injection: rule.injection ?? held?.injection,
    // his ruling is a way of working the owner settled, verified by his own word
    confidence: 'verified',
    authoredBy: 'human',
    type: 'convention',
    orderIndex: held?.orderIndex ?? 0,
    metadata: { ...kept, ruledBy: cite.ruledBy },
    source: cite.source,
    scope: rule.scope ?? held?.scope,
    recheckWhen: rule.recheckWhen ?? held?.recheckWhen,
    ...(rule.module ? { module: rule.module } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      pathOf(issue?.path[0]),
      `${issue?.message ?? 'not a rule the knowledge door takes'}. Nothing was done`,
    );
  }
  const written = await upsertKnowledgeEntry(parsed.data, { userId: at.userId, agency: 'human' });
  return {
    ok: true,
    value: {
      key: written.slug,
      recorded: `rule ${written.slug} ${held ? 'amended' : 'written'} as his`,
    },
  };
}
