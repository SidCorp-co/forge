import { composeLayers } from './prompt/layer.js';
import { ROCKETCHAT_DOOR_LAYERS, WEB_AGENT_DOOR_LAYERS, WEB_DOOR_LAYERS } from './prompt/layers.js';

/** What a door tells `assistantOpening` about itself. */
export interface DoorOpening {
  projectName: string;
  /** A clause completing "answering …" — where this assistant is speaking. */
  venue: string;
  projectSlug?: string | undefined;
  webBaseUrl?: string | undefined;
}

/**
 * The values every door's layers read. A `null` drops the line that reads it; a key left out
 * altogether is a fault the composer throws on.
 */
function openingValues(door: DoorOpening): Record<string, string | null> {
  return {
    projectName: door.projectName,
    venue: door.venue,
    projectSlug: door.projectSlug ?? null,
    webBaseUrl: door.webBaseUrl ?? '',
  };
}

/**
 * The lines every door opens with: who the assistant is, the method, and how to link an issue.
 */
export function assistantOpening(door: DoorOpening): string[] {
  const opening = WEB_DOOR_LAYERS.filter((l) => l.id !== 'door-web');
  return composeLayers(opening, openingValues(door)).split('\n');
}

/**
 * What is true of the Forge web app and of nowhere else.
 */
export function webDoorLines(projectSlug: string, askedBy: string | null): string[] {
  const web = WEB_DOOR_LAYERS.filter((l) => l.id === 'door-web');
  return composeLayers(web, { projectSlug, askedBy }).split('\n');
}

/**
 * The assistant's voice in a Forge conversation.
 */
export function webConversationPersona(
  projectName: string,
  projectSlug: string,
  askedBy: string | null,
): string {
  return composeLayers(WEB_DOOR_LAYERS, {
    ...openingValues({
      projectName,
      venue: 'answering a person in the Forge web app',
      projectSlug,
    }),
    askedBy,
  });
}

/**
 * The same assistant, in a conversation opened in Agent mode.
 */
export function webAgentConversationPersona(
  projectName: string,
  projectSlug: string,
  askedBy: string | null,
): string {
  return composeLayers(WEB_AGENT_DOOR_LAYERS, {
    ...openingValues({
      projectName,
      venue:
        "answering a person in the Forge web app, from a session on this project's own checkout",
      projectSlug,
    }),
    askedBy,
  });
}

/** Just Agent mode's own lines, for the ledger that accounts for each fragment separately. */
export function webAgentDoorLines(askedBy: string | null): string[] {
  const web = WEB_AGENT_DOOR_LAYERS.filter((l) => l.id === 'door-web-agent');
  return composeLayers(web, { askedBy }).split('\n');
}

/**
 * The assistant's voice in a Rocket.Chat room.
 */
/**
 * What a room turn is told when its window was cut before the room went quiet (ISS-1086).
 */
export const MID_CONVERSATION_INSTRUCTION =
  'the messages you were given were cut off before the room went quiet, so the discussion may still be moving and later messages may already exist that you cannot see. Answer only the questions actually asked in the messages you were given. Do not present the discussion as concluded and do not claim the room agreed on anything. Prefer one short, targeted contribution over a summary of the room. If what you can see is too incomplete to add anything useful, decline the turn.';

export function rocketChatDoorPersona(
  door: DoorOpening,
  room: {
    botName?: string | undefined;
    authorUsername?: string | undefined;
    /** The mid-conversation instruction, or null for a window that closed on quiet (ISS-1086). */
    midConversation?: string | null | undefined;
  },
): string {
  return composeLayers(ROCKETCHAT_DOOR_LAYERS, {
    ...openingValues(door),
    botName: room.botName ?? null,
    authorUsername: room.authorUsername ?? null,
    midConversation: room.midConversation ?? null,
  });
}

export function rocketChatDoorLines(
  botName?: string | undefined,
  authorUsername?: string | undefined,
  midConversation?: string | null | undefined,
): string[] {
  const room = ROCKETCHAT_DOOR_LAYERS.filter((l) => l.id === 'door-rocketchat');
  return composeLayers(room, {
    botName: botName ?? null,
    authorUsername: authorUsername ?? null,
    midConversation: midConversation ?? null,
  }).split('\n');
}
