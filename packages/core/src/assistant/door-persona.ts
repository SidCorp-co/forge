// What every assistant door says, composed from the layers.
//
// The text itself lives under `assistant/prompt/` — one module per layer, each naming the
// benchmark tasks that exercise it — and this file is the web door's arrangement of them
// (ISS-1057). A channel's own layer is only what is true of that channel (ISS-1034).

import { composeLayers } from './prompt/layer.js';
import { ROCKETCHAT_DOOR_LAYERS, WEB_DOOR_LAYERS } from './prompt/layers.js';

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
 * The assistant's voice in a Forge conversation and on `POST /api/chat`.
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
 * The assistant's voice in a Rocket.Chat room.
 */
export function rocketChatDoorPersona(
  door: DoorOpening,
  room: { botName?: string | undefined; authorUsername?: string | undefined },
): string {
  return composeLayers(ROCKETCHAT_DOOR_LAYERS, {
    ...openingValues(door),
    botName: room.botName ?? null,
    authorUsername: room.authorUsername ?? null,
  });
}

/** Just the room's own lines, for the ledger that accounts for each fragment separately. */
export function rocketChatDoorLines(
  botName?: string | undefined,
  authorUsername?: string | undefined,
): string[] {
  const room = ROCKETCHAT_DOOR_LAYERS.filter((l) => l.id === 'door-rocketchat');
  return composeLayers(room, {
    botName: botName ?? null,
    authorUsername: authorUsername ?? null,
  }).split('\n');
}
