// The rest of what the owner's Needs you can owe, made from his word in chat (ISS-1299): a feedback
// item's verify or reopen, a suggestion's accept or reject, and a mockup's accept or return. Each
// goes through the same service its Needs-you button's route calls, as him, so his own grants decide
// (the feedback and suggestion services check them; a mockup's route asks project.write, checked
// here the same way). A refusal comes back by its own name with nothing done.

import type { SupportForgeAct } from '@forge/contracts/support-channel';
import { HTTPException } from 'hono/http-exception';
import { reopenFeedback, verifyFeedback } from '../feedback/index.js';
import { isRefusal } from '../lib/refusal.js';
import { acceptMockup, returnMockup } from '../mockups/index.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import { acceptSuggestion, rejectSuggestion } from '../suggestions/index.js';
import type { OpsOutcome } from './ops-types.js';

/** The Needs-you decision acts the owner's word makes here, by the name his Needs you gives each. */
export const DECISION_FORGE_ACTS = [
  'feedback.verify',
  'feedback.reopen',
  'suggestion.accept',
  'suggestion.reject',
  'mockup.accept',
  'mockup.return',
] as const satisfies readonly SupportForgeAct[];
export type DecisionForgeAct = (typeof DECISION_FORGE_ACTS)[number];

const DECISION_ACT = new Set<string>(DECISION_FORGE_ACTS);

export const isDecisionForgeAct = (act: string): act is DecisionForgeAct => DECISION_ACT.has(act);

type Refused = { code: string; path: string; detail: string };
type Done = { ok: true; key: string } | { ok: false; refusals: readonly Refused[] };

/** The service's answer read as done, or its refusals passed on by their own names. */
const outcomeOf = (key: string, out: { ok: boolean; refusals?: readonly Refused[] }): Done =>
  out.ok ? { ok: true, key } : { ok: false, refusals: out.refusals ?? [] };

async function made(
  act: DecisionForgeAct,
  item: string,
  reason: string | undefined,
  at: { projectId: string; userId: string },
): Promise<Done> {
  const actor = { userId: at.userId, agency: 'human' as const };
  const on = { projectId: at.projectId, actor };
  switch (act) {
    case 'feedback.verify':
      return outcomeOf(item, await verifyFeedback({ ...on, ref: item, note: reason }));
    case 'feedback.reopen':
      return outcomeOf(item, await reopenFeedback({ ...on, ref: item, reason }));
    case 'suggestion.accept':
      return outcomeOf(item, await acceptSuggestion({ ...on, id: item, reason }));
    case 'suggestion.reject':
      return outcomeOf(item, await rejectSuggestion({ ...on, id: item, reason }));
    case 'mockup.accept':
    case 'mockup.return': {
      const refused = await permissionRefusalFor(
        actorFor(at.userId),
        'project.write',
        projectResource(at.projectId),
        act === 'mockup.accept' ? 'accepting a mockup' : 'returning a mockup',
      );
      if (refused) return { ok: false, refusals: [refused] };
      const decide = act === 'mockup.accept' ? acceptMockup : returnMockup;
      return outcomeOf(item, await decide({ ...on, ref: item, reason }));
    }
  }
}

/**
 * Make `act` on `item` as the owner, through its own service: what was made, or every refusal by
 * its own name, with nothing done.
 */
export async function decisionForgeAct(
  act: DecisionForgeAct,
  item: string,
  reason: string | undefined,
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  let out: Done;
  try {
    out = await made(act, item, reason, at);
  } catch (err) {
    if (isRefusal(err)) return { ok: false, refusals: [...err.refusals] };
    if (err instanceof HTTPException && (err.status === 403 || err.status === 404)) {
      const code = (err.cause as { code?: string } | undefined)?.code ?? 'FORBIDDEN';
      return {
        ok: false,
        refusals: [{ code, path: '/item', detail: `${err.message}. Nothing was done` }],
      };
    }
    throw err;
  }
  if (!out.ok) {
    return {
      ok: false,
      refusals: out.refusals.map((r) => ({ ...r, detail: `${r.detail} Nothing was done` })),
    };
  }
  return { ok: true, value: { key: out.key, recorded: `${act} on ${out.key}` } };
}
