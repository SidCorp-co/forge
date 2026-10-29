/**
 * The Forge door's acts, once for REST and MCP (REQ-47): file a report about Forge as the caller's own
 * account, list the caller's own reports, read one, confirm or reopen one's shipped fix (REQ-66
 * BC-8), and reply once to its answer (REQ-47 BC-12). Every refusal is named and writes nothing.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import type {
  ForgeFeedbackAnswersClaimed,
  ForgeFeedbackFiled,
  ForgeFeedbackItem,
  ForgeFeedbackList,
  ForgeFeedbackRequest,
} from '@forge/contracts/forge-feedback';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import {
  claimAnswersTold,
  type ForgeCaller,
  feedbackEgress,
  fileForgeFeedback,
  forgeFeedbackIdOfKey,
  forgeRefusal,
  HOME_NOT_SET,
  listFeedbackIn,
  ownForgeFeedbackIds,
  type ReadDoor,
  replyOwnForgeFeedback,
  reportedForge,
  resolveForgeSource,
  settleOwnForgeFeedback,
  shipEvidenceOfShipped,
  toldOf,
  untoldAnswersOf,
} from '../feedback/index.js';
import { forgeHomeProject } from '../instance-settings/index.js';
import { dataPolicyOf } from '../lib/data-egress.js';
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
  // the evidence is the item's content as much as its words are: a policy that withholds one withholds both
  const { withhold } = feedbackEgress(await dataPolicyOf(homeId), viewer.agency, door);
  const shown = ids.map((id) => {
    const s = byId.get(id);
    if (!s) throw new Error(`forge feedback: item ${id} of the home project does not read back`);
    return s;
  });
  // what triage told the reporter is theirs to read at the item, through this door too (BC-10)
  const told = await toldOf(homeId, shown, withhold);
  const items: ForgeFeedbackItem[] = [];
  for (const s of shown) {
    const evidence = withhold ? null : await shipEvidenceOfShipped(homeId, s.id, s.phase);
    const said = told.get(s.id);
    if (!said)
      throw new Error(`forge feedback: what item ${s.id} told its reporter does not read back`);
    items.push(forgeItemOf(s, reads, evidence, said));
  }
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

/**
 * The answers on the caller's own items none of its sessions has been told, each recorded as told in
 * this call (REQ-47 BC-11). The text is what the item tells its reporter, read as every door reads it
 * (`feedback/told.ts:toldOf`); an answer that no longer reads back is not claimed.
 */
export async function claimForgeAnswers(
  viewer: ForgeViewer,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackAnswersClaimed>> {
  const home = await forgeHomeProject();
  if (!home) return refused(HOME_NOT_SET);
  const untold = await untoldAnswersOf(
    await ownForgeFeedbackIds(home.id, viewer.userId),
    viewer.userId,
  );
  if (untold.length === 0) return { ok: true, value: { answers: [], returned: 0 } };
  const listed = await listFeedbackIn(
    viewer,
    home.id,
    { ids: untold.map((u) => u.feedbackId) },
    door,
  );
  if (!listed.ok) {
    throw new Error(
      `forge feedback: the home project's list refused a read by id: ${listed.refusals[0]?.detail}`,
    );
  }
  const { withhold } = feedbackEgress(await dataPolicyOf(home.id), viewer.agency, door);
  const told = await toldOf(home.id, listed.list.feedback, withhold);
  const said = untold.flatMap((u) => {
    const answer = told.get(u.feedbackId)?.answer?.trim();
    return answer ? [{ ...u, answer }] : [];
  });
  const claimed = await claimAnswersTold(
    said.map((s) => s.decisionId),
    viewer.userId,
  );
  const answers = said
    .filter((s) => claimed.has(s.decisionId))
    .map((s) => ({
      key: feedbackKey(s.fbSeq),
      answer: s.answer,
      answeredAt: s.answeredAt.toISOString(),
    }));
  return { ok: true, value: { answers, returned: answers.length } };
}

/** The home project and the id of one item the viewer may read, or the refusal naming why not. */
async function readableItem(
  viewer: ForgeViewer,
  key: string,
): Promise<{ ok: true; homeId: string; id: string } | { ok: false; refusals: Refusal[] }> {
  const home = await forgeHomeProject();
  if (!home) return { ok: false, refusals: [HOME_NOT_SET] };
  const notFound = forgeRefusal(
    'FORGE_FEEDBACK_NOT_FOUND',
    '/feedback',
    `${key} is not feedback to Forge you reported; GET /api/forge/feedback lists yours.`,
  );
  const id = await forgeFeedbackIdOfKey(home.id, key);
  if (!id) return { ok: false, refusals: [notFound] };
  const may =
    (await readsHomeAsMember(home.id, viewer.userId)) || (await reportedForge(id, viewer.userId));
  if (!may) return { ok: false, refusals: [notFound] };
  return { ok: true, homeId: home.id, id };
}

/** One item: the caller's own, or any item of the home project for one of its members. */
export async function getForgeFeedback(
  viewer: ForgeViewer,
  key: string,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackItem>> {
  const found = await readableItem(viewer, key);
  if (!found.ok) return found;
  return { ok: true, value: await itemById(viewer, found.homeId, found.id, door) };
}

/** The caller confirms the shipped fix of an item it reported, or reopens it, with its evidence. */
export async function settleForgeFeedback(
  viewer: ForgeViewer,
  key: string,
  act: 'verified' | 'reopened',
  evidence: string | undefined,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackItem>> {
  const found = await readableItem(viewer, key);
  if (!found.ok) return found;
  const refusals = await settleOwnForgeFeedback({
    homeId: found.homeId,
    feedbackId: found.id,
    actor: { userId: viewer.userId, agency: viewer.agency },
    act,
    evidence,
  });
  if (refusals) return { ok: false, refusals };
  return { ok: true, value: await itemById(viewer, found.homeId, found.id, door) };
}

/** The caller replies to the answer on an item it reported, once, with what the answer leaves open. */
export async function replyForgeFeedback(
  viewer: ForgeViewer,
  key: string,
  evidence: string | undefined,
  door: ReadDoor,
): Promise<Answer<ForgeFeedbackItem>> {
  const found = await readableItem(viewer, key);
  if (!found.ok) return found;
  const refusals = await replyOwnForgeFeedback({
    homeId: found.homeId,
    feedbackId: found.id,
    actor: { userId: viewer.userId, agency: viewer.agency },
    evidence,
  });
  if (refusals) return { ok: false, refusals };
  return { ok: true, value: await itemById(viewer, found.homeId, found.id, door) };
}
