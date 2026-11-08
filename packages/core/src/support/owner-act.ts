// An act in the product as its owner (ISS-1013, REQ-85 BC-1, BC-4, BC-7, BC-8). The session names an
// `owner` tool its project's support-api binding declares; core makes the call, from core, with the
// owner's credential it keeps for that binding, and hands the session only the answer, scrubbed of
// every credential value. So the session never holds the credential, and a box with no route to the
// product still acts. Refused by name, and nothing sent, in any room but the owner's own, in a
// product his standing consent does not cover, or where no credential of his is kept; each refusal
// says who can consent or who keeps the credential.
//
// ISS-1014: the act names the message asking for it, one handed to the turn in its thread, and is
// logged beside it; the product is told on every act that it came through the assistant
// (`OWNER_ACT_VIA`), which its own record keeps where it records the header. An act the product gates
// on the owner's approval waits on a design step the support-group design does not draw yet.

import { scrubSecretsDeep } from '@forge/observability';
import {
  callGranted,
  credentialValuesOf,
  planSupportCall,
  type SupportCallArgs,
  type SupportCallResult,
  supportApisOf,
} from '../integrations/support-api/index.js';
import { holderNames } from '../permissions/index.js';
import { writerOfHandedMessage } from './delivery.js';
import { supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { ownerRoomOf, standingConsent, whoCanConsent, whoSignsIn } from './owner-consent.js';
import { ownerHeadersFor } from './owner-refresh.js';
import type { Refusal } from './refusals.js';
import { limitsOf } from './rules.js';
import { insertAction, type RoomRow } from './store.js';

/** What an owner act came back with: the product's answer, and as whom and where it was made. */
export type OwnerActResult = SupportCallResult & {
  product: string;
  /** The owner's chat account the act was made as, under the consent it rests on. */
  asOwner: string;
  consentGivenAt: string;
};

/** Who keeps the owner's credential: the project's admins, by name. */
async function keeperOf(projectId: string): Promise<string> {
  const names = await holderNames('project.admin', projectId);
  return names.length > 0
    ? `a project admin (${names.join(', ')}) keeps it`
    : 'nobody holds project admin on this project, so an organization admin must first name one, who keeps it';
}

/**
 * What the product is told on every owner act (ISS-1014): made through Forge's assistant, for the
 * owner whose credential it carries, and which room message asked for it.
 */
export const OWNER_ACT_VIA = 'X-Forge-Via';

export async function ownerAct(
  room: RoomRow,
  input: { thread: string; message: string; tool: string; args?: SupportCallArgs | undefined },
): Promise<Outcome<OwnerActResult>> {
  const args = input.args ?? {};
  const conversationId = await knownThread(room, input.thread);
  const refusedWith = async (out: Outcome<never>) => {
    if (!out.ok && conversationId) {
      const [first] = out.refusals as Refusal[];
      await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId,
        thread: input.thread,
        kind: 'refused',
        actorKind: 'core',
        tool: 'owner_act',
        input: { tool: input.tool, args, message: input.message },
        output: { code: first?.code, detail: first?.detail, posted: false },
      });
    }
    return out;
  };
  const at = await ownerRoomOf(room, 'owner_act');
  if (!at.ok) return refusedWith(at);
  if (!conversationId) return threadUnknown(input.thread);
  if (!(await writerOfHandedMessage(room.id, input.thread, input.message))) {
    return refusedWith(
      no(
        'SUPPORT_MESSAGE_UNKNOWN',
        '/message',
        `message ${input.message} is no member's message in thread ${input.thread} that this turn was handed; an owner act is logged beside the message asking for it, so name that one, as it carries \`message\` in what you were handed. Nothing was sent`,
      ),
    );
  }
  const apis = await supportApisOf(room.projectId);
  const planned = planSupportCall({ apis, name: input.tool, kind: 'owner', args });
  if ('refusal' in planned) {
    return refusedWith(no(planned.refusal.code, '/tool', planned.refusal.detail));
  }
  const { api, plan } = planned;
  const consent = await standingConsent(room.id, api.bindingId);
  if (!consent) {
    return refusedWith(
      no(
        'SUPPORT_OWNER_NO_CONSENT',
        '/tool',
        `the owner has not consented to this room acting as him in ${api.name}, or has withdrawn it, so nothing was sent; ${await whoCanConsent(room, at.value)}.`,
      ),
    );
  }
  // an OAuth credential is refreshed here first where it needs it (ISS-1047); a dead one is never sent
  const owner = await ownerHeadersFor({
    projectId: room.projectId,
    api,
    words: {
      keeper: await keeperOf(room.projectId),
      signsInAgain: await whoSignsIn(room, at.value),
    },
  });
  if (!owner.ok) return refusedWith(owner);
  const called = await callGranted({
    plan,
    config: api.config,
    headers: owner.value.headers,
    marks: {
      [OWNER_ACT_VIA]: `assistant; on-behalf-of=${consent.ownerKey}; room=${room.rid}; message=${input.message}`,
    },
    maxBytes: limitsOf(await supportConfigOf(room)).responseMaxBytes,
  });
  if ('refusal' in called) {
    return refusedWith(no(called.refusal.code, '/tool', called.refusal.detail));
  }
  // the owner's access token is scrubbed by the door that sent it; his refresh token and the
  // binding's own credential are scrubbed too, so none comes back whatever the product echoes
  const result: SupportCallResult = {
    ...called.result,
    body: scrubSecretsDeep(called.result.body, [
      ...owner.value.secrets,
      ...credentialValuesOf(api.headers),
    ]),
  };
  const value: OwnerActResult = {
    ...result,
    product: api.name,
    asOwner: consent.ownerKey,
    consentGivenAt: consent.givenAt.toISOString(),
  };
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'owner_act',
    actorKind: 'core',
    tool: input.tool,
    input: { args, product: api.name, consent: consent.id, message: input.message },
    output: result,
  });
  return { ok: true, value };
}
