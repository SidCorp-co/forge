// A Product act on an item made on the person's word (REQ-69 BC-3, BC-5, BC-6): each act calls the
// service its item page's own REST route calls, as the person, so the one permission and state rule
// the page meets is the one the chat meets, and no second write path exists. The door's refusal is
// passed through by its own name, with what the person can do next; a refusal is never absorbed into
// a done.

import type { ItemAct, ItemActPlan } from '@forge/contracts/item-acts';
import { HTTPException } from 'hono/http-exception';
import { triageFeedback } from '../../feedback/index.js';
import { isRefusal, type Refusal } from '../../lib/refusal.js';
import { cutReleaseAs, decideApprovalOfVersion, parseDecision } from '../../release-batch/index.js';
import {
  acceptDelivery,
  acceptRevision,
  agreeRequirement,
  deferRequirement,
  dropRequirement,
  proposeRevision,
  returnRevision,
  undeferRequirement,
} from '../../requirements/index.js';
import { decideDesignAs, proposeDesign } from '../../workflows/index.js';
import { thrownMessage } from './mcp-adapter.js';

/** Why the door refused the act: its own code and sentence. */
export interface DoorRefusal {
  code: string;
  detail: string;
}

type Outcome = { ok: true } | { ok: false; refusals: readonly Refusal[] };

const fromOutcome = (o: { ok: boolean; refusals?: readonly Refusal[] }): Outcome =>
  o.ok ? { ok: true } : { ok: false, refusals: o.refusals ?? [] };

/** The act's own door, called as the person with what the set kept. */
async function callDoor(
  plan: ItemActPlan,
  reason: string | undefined,
  at: { projectId: string; userId: string },
): Promise<Outcome> {
  const actor = { userId: at.userId, agency: 'human' as const };
  const { projectId } = at;
  const ref = plan.ref;
  const revision = plan.revision ?? 0;
  const said = reason ?? '';
  const doors: Record<ItemAct, () => Promise<Outcome>> = {
    'requirement.propose': async () =>
      fromOutcome(await proposeRevision({ projectId, ref, actor, revision })),
    'requirement.agree': async () =>
      fromOutcome(await agreeRequirement({ projectId, ref, actor, revision, reason })),
    'requirement.accept': async () =>
      fromOutcome(await acceptRevision({ projectId, ref, actor, revision, reason })),
    'requirement.return': async () =>
      fromOutcome(await returnRevision({ projectId, ref, actor, revision, reason: said })),
    'requirement.defer': async () =>
      fromOutcome(await deferRequirement({ projectId, ref, actor, reason: said })),
    'requirement.undefer': async () =>
      fromOutcome(await undeferRequirement({ projectId, ref, actor, reason: said })),
    'requirement.drop': async () =>
      fromOutcome(await dropRequirement({ projectId, ref, actor, reason: said })),
    'requirement.accept_delivery': async () =>
      fromOutcome(await acceptDelivery({ projectId, ref, actor, revision, reason })),
    'feedback.triage': async () =>
      fromOutcome(
        await triageFeedback({
          projectId,
          ref,
          actor,
          triage: plan.triage ?? {},
          channel: 'web',
        }),
      ),
    'workflow.propose': async () =>
      fromOutcome(await proposeDesign({ projectId, id: ref, writer: actor, revision })),
    'workflow.approve': async () =>
      fromOutcome(
        await decideDesignAs({
          projectId,
          id: ref,
          decider: actor,
          revision,
          decision: 'approve',
          reason: reason ?? null,
        }),
      ),
    'workflow.return': async () =>
      fromOutcome(
        await decideDesignAs({
          projectId,
          id: ref,
          decider: actor,
          revision,
          decision: 'return',
          reason: said,
        }),
      ),
    'release.cut': async () => {
      await cutReleaseAs({
        projectId,
        userId: at.userId,
        agency: 'human',
        issueIds: plan.issueIds ?? [],
      });
      return { ok: true };
    },
    'release.approve': async () => {
      const decision = parseDecision({ decision: 'approve', ...(reason ? { reason } : {}) });
      await decideApprovalOfVersion({ projectId, version: ref, userId: at.userId, decision });
      return { ok: true };
    },
    'release.return': async () => {
      const decision = parseDecision({ decision: 'return', reason: said });
      await decideApprovalOfVersion({ projectId, version: ref, userId: at.userId, decision });
      return { ok: true };
    },
  };
  return doors[plan.act]();
}

/** A thrown refusal as the door named it, or null where the throw is no refusal (a bug, thrown on). */
function thrownRefusal(err: unknown): DoorRefusal | null {
  if (isRefusal(err)) {
    const first = err.refusals[0];
    return { code: first?.code ?? err.fallbackCode, detail: thrownMessage(err) };
  }
  if (err instanceof HTTPException) {
    const cause = err.cause as { code?: unknown } | undefined;
    const code = typeof cause?.code === 'string' ? cause.code : `HTTP_${err.status}`;
    return { code, detail: thrownMessage(err) };
  }
  return null;
}

/** Make the act through its door as the person: done, or the door's refusal by its own name. */
export async function makeItemAct(
  plan: ItemActPlan,
  reason: string | undefined,
  at: { projectId: string; userId: string },
): Promise<{ ok: true } | ({ ok: false } & DoorRefusal)> {
  try {
    const outcome = await callDoor(plan, reason, at);
    if (outcome.ok) return { ok: true };
    const first = outcome.refusals[0];
    return {
      ok: false,
      code: first?.code ?? 'REFUSED',
      detail: outcome.refusals.map((r) => `${r.code}: ${r.detail}`).join('; '),
    };
  } catch (err) {
    const refused = thrownRefusal(err);
    if (!refused) throw err;
    return { ok: false, ...refused };
  }
}

const PERMISSION = /FORBIDDEN|PERMISSION|NOT_SIGNER|SIGNER|APPROVER|NOT_MEMBER|MASTER_ACT/;

/** What the person can do after the door refused `act` on `key` (REQ-69 BC-5). */
export function nextAfterRefusal(code: string, key: string): string {
  if (PERMISSION.test(code))
    return `Ask someone who holds that permission on this project to make it, or a project admin to grant it.`;
  return `Open ${key}, fix what the refusal names, then ask again and the chat will put the act to you anew.`;
}
