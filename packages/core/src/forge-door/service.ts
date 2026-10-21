/**
 * The Forge door's acts, once for REST and MCP (REQ-47): file a report about Forge as the caller's own
 * account, list the caller's own reports, read one. Every refusal is named and writes nothing.
 */

import type {
  ForgeFeedbackFiled,
  ForgeFeedbackItem,
  ForgeFeedbackList,
  ForgeFeedbackRequest,
} from '@forge/contracts/forge-feedback';
import {
  type ForgeCaller,
  fileForgeFeedback,
  forgeRefusal,
  HOME_NOT_SET,
  ownForgeFeedbackIds,
  type ReadDoor,
  reportedForge,
  resolveForgeSource,
} from '../feedback/index.js';
import { forgeHomeProject } from '../instance-settings/index.js';
import type { Refusal } from '../lib/refusal.js';
import { isWidgetPrincipal } from '../widget/index.js';
import { type ForgeViewer, forgeItemOf, homeReads, readsHomeAsMember } from './reads.js';

export type Answer<T> = { ok: true; value: T } | { ok: false; refusals: Refusal[] };

const refused = <T>(refusal: Refusal): Answer<T> => ({ ok: false, refusals: [refusal] });

export interface ForgeDoorCaller extends ForgeCaller, ForgeViewer {}

async function itemById(
  viewer: ForgeViewer,
  homeId: string,
  id: string,
  door: ReadDoor,
): Promise<ForgeFeedbackItem> {
  const { all, reads } = await homeReads(viewer, homeId, door);
  const s = all.find((x) => x.id === id);
  if (!s) throw new Error(`forge feedback: item ${id} was written and does not read back`);
  return forgeItemOf(s, reads);
}

export async function submitForgeFeedback(
  caller: ForgeDoorCaller,
  request: ForgeFeedbackRequest,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackFiled>> {
  if (await isWidgetPrincipal(caller.userId)) {
    return refused(
      forgeRefusal(
        'FORGE_FEEDBACK_CHANNEL_ACCOUNT',
        '',
        "this is a widget binding's own account, which files only for that site's visitors and only into its own project; feedback about Forge is filed by a person or an agent with an account of their own.",
      ),
    );
  }
  const source = await resolveForgeSource(caller, request.from, request.clientVersion);
  if ('code' in source) return refused(source);
  const actor = { userId: caller.userId, agency: caller.agency };
  const filed = await fileForgeFeedback({ actor, request, source });
  if (!filed.ok) return filed;
  return {
    ok: true,
    value: {
      created: filed.created,
      feedback: await itemById(actor, filed.homeId, filed.id, door),
    },
  };
}

export async function listOwnForgeFeedback(
  viewer: ForgeViewer,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackList>> {
  const home = await forgeHomeProject();
  if (!home) return refused(HOME_NOT_SET);
  const ids = await ownForgeFeedbackIds(home.id, viewer.userId);
  const { all, reads } = await homeReads(viewer, home.id, door);
  const byId = new Map(all.map((s) => [s.id, s]));
  const feedback = ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [forgeItemOf(s, reads)] : [];
  });
  return {
    ok: true,
    value: { feedback, returned: feedback.length, home, asOf: reads.asOf },
  };
}

/** One item: the caller's own, or any item of the home project for one of its members. */
export async function getForgeFeedback(
  viewer: ForgeViewer,
  key: string,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackItem>> {
  const home = await forgeHomeProject();
  if (!home) return refused(HOME_NOT_SET);
  const notFound = forgeRefusal(
    'FORGE_FEEDBACK_NOT_FOUND',
    '/feedback',
    `${key} is not feedback to Forge you reported; GET /api/forge/feedback lists yours.`,
  );
  const { all, reads } = await homeReads(viewer, home.id, door);
  const s = all.find((x) => x.key === key);
  if (!s) return refused(notFound);
  const may =
    (await readsHomeAsMember(home.id, viewer.userId)) || (await reportedForge(s.id, viewer.userId));
  return may ? { ok: true, value: forgeItemOf(s, reads) } : refused(notFound);
}
