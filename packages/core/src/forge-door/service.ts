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
import { fencedProjectIds } from '../credentials/pat-scope.js';
import {
  type ForgeCaller,
  fileForgeFeedback,
  forgeFeedbackIdOfKey,
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

/** The project the credential is fenced to, where it is fenced to one: a box's token names its own. */
export function fencedProjectOfCredential(): string | null {
  const fence = fencedProjectIds();
  return fence?.length === 1 ? (fence[0] ?? null) : null;
}

/** The items `ids` names, in that order; one that does not read back is a loud failure, never a gap. */
async function itemsById(
  viewer: ForgeViewer,
  homeId: string,
  ids: readonly string[],
  door: ReadDoor,
): Promise<{ items: ForgeFeedbackItem[]; asOf: string }> {
  const { all, reads } = await homeReads(viewer, homeId, door, ids);
  const byId = new Map(all.map((s) => [s.id, s]));
  const items = ids.map((id) => {
    const s = byId.get(id);
    if (!s) throw new Error(`forge feedback: item ${id} of the home project does not read back`);
    return forgeItemOf(s, reads);
  });
  return { items, asOf: reads.asOf };
}

async function itemById(
  viewer: ForgeViewer,
  homeId: string,
  id: string,
  door: ReadDoor,
): Promise<ForgeFeedbackItem> {
  const [item] = (await itemsById(viewer, homeId, [id], door)).items;
  if (!item) throw new Error(`forge feedback: item ${id} of the home project does not read back`);
  return item;
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
  const { items: feedback, asOf } = await itemsById(viewer, home.id, ids, door);
  return {
    ok: true,
    value: { feedback, returned: feedback.length, home, asOf },
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
  const id = await forgeFeedbackIdOfKey(home.id, key);
  if (!id) return refused(notFound);
  const may =
    (await readsHomeAsMember(home.id, viewer.userId)) || (await reportedForge(id, viewer.userId));
  if (!may) return refused(notFound);
  return { ok: true, value: await itemById(viewer, home.id, id, door) };
}
