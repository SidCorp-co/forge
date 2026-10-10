// What the Forge UI contributes to a turn: the Agent-mode diversion, and in Assistant mode the
// persona and toolset the room's subject calls for.

import { eq } from 'drizzle-orm';
import {
  type ConversationImage,
  getConversation,
  readRoomDocumentByName,
  readRoomDocumentByRef,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { firstRequirementsOnboardingOf } from '../onboarding/index.js';
import { makeConversationImageResolver } from './conversation-images.js';
import {
  baDoorPersona,
  baFirstRequirementsPersona,
  webConversationPersona,
} from './door-persona.js';
import { turnPageContext } from './page-item.js';
import type { WindowTurnInputs } from './route-window.js';
import {
  buildBaFirstRequirementsToolset,
  buildRequirementDraftToolset,
} from './tools/ba-first-tools.js';
import { buildBaToolset } from './tools/ba-tools.js';
import { mergeToolsets } from './tools/mcp-adapter.js';
import { buildOfferActToolset } from './tools/offer-act-tool.js';
import { buildOfferPreviewToolset } from './tools/offer-preview-tool.js';
import { buildChatToolContext } from './tools/principal.js';
import { buildProjectToolset, buildRecordToolset } from './tools/registry.js';
import { buildUiActionToolset } from './tools/ui-actions-tool.js';
import { askerLineLanguage, askerWithRole } from './turn-asker.js';
import { fenceToolsetToOrigin, handoffVenueRefusal, turnOriginRefused } from './turn-origin.js';
import type { TurnHookContext, TurnInputs } from './turn-request.js';
import { latestUiSnapshot } from './ui-snapshot.js';
import { divertToAgent } from './web-agent-diversion.js';
import type { WebTurnArgs } from './web-turn-args.js';

/**
 * What the Forge UI contributes to a turn: who the assistant is, and what it may read.
 */
export function webConversationTurn(args: WebTurnArgs): WindowTurnInputs {
  return {
    door: 'web-chat-reply',
    // the conversation list reads "Waiting on you" from the reply row, so every Assistant-mode
    // turn here is offered `await_reply` (ISS-277); an Agent-mode turn is diverted before it runs
    recordsAsks: true,
    externalStop: args.externalStop,
    handleName: args.handleName,
    log: { adapter: 'web', projectId: args.project.id, mode: args.window.mode },

    onTurnEvent: args.progress.onTurnEvent,
    onSettled: args.progress.onSettled,
    replyEntry: (deliveredText) => ({
      id: args.progress.entryId,
      blocks: args.progress.blocksForRecord(deliveredText),
    }),

    continueEntry: () => {
      const rest = args.progress.next();
      return {
        onTurnEvent: rest.onTurnEvent,
        onSettled: rest.onSettled,
        replyEntry: (deliveredText) => ({
          id: rest.entryId,
          blocks: rest.blocksForRecord(deliveredText),
        }),
        close: () => rest.close(),
      };
    },

    divertBeforeTurn: ({ setPhase, authority }) => divertToAgent(args, setPhase, authority),
    prepare: (ctx) => prepareWebTurn(args, ctx),
  };
}

async function requirementKeyOf(requirementId: string): Promise<string> {
  const [row] = await db
    .select({ seq: requirements.reqSeq })
    .from(requirements)
    .where(eq(requirements.id, requirementId))
    .limit(1);
  return row ? `REQ-${row.seq}` : requirementId;
}

/** Assistant mode: the persona and toolset the room's subject calls for. */
async function prepareWebTurn(
  args: WebTurnArgs,
  {
    credential,
    speakerUserId,
    conversationId,
    handleUserId,
    authority,
    blockStage,
  }: TurnHookContext,
): Promise<TurnInputs> {
  // the token is minted while the room is read; a venue refusal still wins over what minting says
  const minting = credential();
  minting.catch(() => undefined);
  const room = await getConversation(conversationId);
  // a hand-off turn acts only in its first-requirements room; anywhere else it is refused
  const venueRefusal =
    authority.origin === 'onboarding_handoff' ? handoffVenueRefusal(room?.externalId) : null;
  if (venueRefusal) throw turnOriginRefused(venueRefusal);
  const ctx = buildChatToolContext({
    credential: await minting,
    projectSlug: args.project.slug,
    turn: {
      conversationId,
      speakerUserId,
      handleUserId,
      ecosystemId: room?.ecosystemId ?? null,
      readDocument: (file) => readRoomDocumentByName(conversationId, file),
      blockStage,
    },
  });
  const resolveDocument = (file: ConversationImage) =>
    readRoomDocumentByRef(conversationId, file.ref);
  const asker = await askerWithRole(args.project.id, authority.userId, args.askedBy);
  // a room opened about a requirement answers through the BA door: its persona and its narrow
  // tool set, plus the record tools, so a problem or a new wish said here has somewhere to go
  // (REQ-30 BC-3); never the project toolset or the UI actions
  if (room?.requirementId) {
    const key = await requirementKeyOf(room.requirementId);
    return {
      persona: baDoorPersona(args.project.name, key, asker),
      resolveImage: makeConversationImageResolver(conversationId),
      resolveDocument,
      tools: mergeToolsets(
        buildBaToolset(ctx, { projectId: args.project.id, requirementId: room.requirementId }),
        buildRecordToolset(ctx),
        buildRequirementDraftToolset(ctx, args.project.id),
      ),
    };
  }
  const onboardingId = firstRequirementsOnboardingOf(room?.externalId);
  if (onboardingId) {
    return {
      persona: baFirstRequirementsPersona(args.project.name, asker),
      resolveImage: makeConversationImageResolver(conversationId),
      resolveDocument,
      tools: fenceToolsetToOrigin(
        buildBaFirstRequirementsToolset(ctx, { projectId: args.project.id, onboardingId }),
        authority.origin,
      ),
    };
  }
  return {
    persona: webConversationPersona(args.project.name, args.project.slug, asker),
    resolveImage: makeConversationImageResolver(conversationId),
    resolveDocument,
    pageContext: await turnPageContext({
      conversationId,
      projectId: args.project.id,
      userId: authority.userId,
    }),
    tools: mergeToolsets(
      buildProjectToolset(ctx),
      buildRequirementDraftToolset(ctx, args.project.id),
      buildUiActionToolset(
        { snapshot: () => latestUiSnapshot(conversationId) },
        args.window.question,
      ),
      buildOfferActToolset({
        projectId: args.project.id,
        userId: authority.userId,
        language: await askerLineLanguage(args),
      }),
      buildOfferPreviewToolset({ projectId: args.project.id, userId: authority.userId }),
    ),
  };
}
