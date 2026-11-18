// A finding handed to another project's intake through the ecosystem channel (ISS-1286, REQ-102):
// sidcorp-mail's master found FB-13 was sid-desk's code, was refused PAT_PROJECT_OUTSIDE_FENCE filing
// it on sid-desk, and carried it by a message to sid-desk's pane that nothing in Forge recorded (FB-636).
// The channel decides where a finding may go: to a project an ecosystem the sender is active in shows
// it (`fence-way.ts:fenceChannelWay`, the same reading a fence refusal names), counterparties or not,
// since a defect in another project's part need not touch a contract the two share. A project no
// ecosystem shows is refused by name with who links them, reading the same whether it is hidden or
// does not exist. The filing and both records are the feedback module's (`feedback/handoff.ts`).

import type { ChannelHandoffRequest, ChannelHandoffView } from '@forge/contracts/channel-handoff';
import { db } from '../db/client.js';
import {
  feedbackRefIn,
  fileHandoff,
  type HandedItem,
  type Handoff,
  issueRefIn,
} from '../feedback/index.js';
import { fenceChannelWay, whoLinksSaid } from './fence-way.js';
import type { EcosystemRefusal } from './refusals.js';
import { projectsWhere } from './store.js';

export type HandoffOutcome =
  | { ok: true; handoff: ChannelHandoffView }
  | { ok: false; refusals: EcosystemRefusal[] };

const GUIDE = 'GET /api/guides/ecosystem-inbox.md';
const FEEDBACK_KEY = /^FB-\d+$/i;

/** The issue or feedback item of `projectId` the handoff names, or the refusal saying it names none. */
async function itemOf(
  projectId: string,
  ref: string,
  userId: string,
): Promise<HandedItem | EcosystemRefusal> {
  const found = FEEDBACK_KEY.test(ref)
    ? await feedbackRefIn(projectId, ref, '/item')
    : await issueRefIn(projectId, ref, userId, '/item');
  if ('code' in found) {
    return {
      code: 'HANDOFF_ITEM_UNKNOWN',
      path: '/item',
      detail: `item names the issue (ISS-12, or its uuid) or the feedback item (FB-4) of this project the finding is handed from; ${found.detail}`,
    };
  }
  return { kind: FEEDBACK_KEY.test(ref) ? 'feedback' : 'issue', id: found.id, key: found.key };
}

/**
 * Hands one finding from `projectId`'s item to the intake of the project `request.to` names: filed
 * there as feedback naming its source, and recorded on the item with the key it was filed under.
 */
export async function handOff(input: {
  projectId: string;
  actor: Handoff['actor'];
  request: ChannelHandoffRequest;
}): Promise<HandoffOutcome> {
  const { projectId, actor, request } = input;
  if (request.to.toLowerCase() === projectId.toLowerCase()) {
    return {
      ok: false,
      refusals: [
        {
          code: 'HANDOFF_TO_OWN_PROJECT',
          path: '/to',
          detail: `to names this project; a finding about its own part goes to its own feedback door (POST /api/projects/${projectId}/feedback), and a handoff is for another project's intake.`,
        },
      ],
    };
  }
  const [item, channel, [own]] = await Promise.all([
    itemOf(projectId, request.item, actor.userId),
    fenceChannelWay([projectId], { id: request.to, ref: request.to }),
    projectsWhere(db, { ids: [projectId] }),
  ]);
  const fromSlug = own?.slug ?? projectId;
  const way = channel.ways.find((w) => w.contract !== null) ?? channel.ways[0];
  const refusals: EcosystemRefusal[] = [];
  if ('code' in item) refusals.push(item);
  if (!way) {
    refusals.push({
      code: 'HANDOFF_NOT_LINKED',
      path: '/to',
      detail:
        `No ecosystem links ${fromSlug} to project ${request.to}, so a finding cannot be handed to its intake: ` +
        `a handoff reaches only a project shown to ${fromSlug} as a peer in an ecosystem it is active in ` +
        `(GET /api/projects/${projectId}/ecosystems lists them under \`peers\`). ` +
        `To link them, ${whoLinksSaid([fromSlug], channel.stewards)} (${GUIDE}).`,
    });
  }
  if (refusals.length > 0 || !way || 'code' in item) return { ok: false, refusals };
  const filed = await fileHandoff({
    from: { id: projectId, slug: fromSlug, item },
    to: way.to,
    via: way.ecosystem.slug,
    actor,
    request,
  });
  if (!filed.ok) return { ok: false, refusals: filed.refusals as EcosystemRefusal[] };
  return {
    ok: true,
    handoff: {
      ecosystem: way.ecosystem,
      from: { project: { id: projectId, slug: fromSlug }, item: item.key },
      to: { project: way.to, feedback: { id: filed.id, key: filed.key } },
      created: filed.created,
    },
  };
}
