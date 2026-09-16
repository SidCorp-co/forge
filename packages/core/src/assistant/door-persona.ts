// What every assistant door says, composed from the layers.
//
// The text itself lives under `assistant/prompt/` — one module per layer, each naming the
// benchmark tasks that exercise it — and this file is the web door's arrangement of them
// (ISS-1057). A channel's own layer is only what is true of that channel (ISS-1034).

// cm:guard this module parses NO environment and must not start to: `web-door.test.ts` and `conversation-send.test.ts` mock `db/client.js` precisely so that composing a persona needs no env, and an `env` import here makes both fail to COLLECT rather than fail an assertion — a whole file's coverage gone for a string. A door that has a web origin passes it in (ISS-1007).
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
// cm:guard `webBaseUrl` defaults to the EMPTY STRING and `projectSlug` to null, and the two are not
// the same absence: an absent origin yields a root-relative path, while an absent slug is the one
// value that drops the link line — making the whole instruction conditional on an origin is how the
// web doors silently stopped being told to link an issue at all (ISS-1007).
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
// cm:guard the method body is RENDERED here and no line tells the model to fetch it: ISS-1007 made it a guide so twenty bullets stopped being copied into each persona, and the one copy stays — in the `base` and `tools` layers, which `assistant-method-guide.ts` composes its body from — but a method the model must spend a tool round retrieving is one it can skip, and measured on beta 2026-09-15 the fetch cost a provider round-trip on every turn including "ping" for a 2 ms read of a constant. Delivering the text is what the ISS-1007 guard asked for; fetching was the means, not the end (ISS-1034).
// cm:edge contract -> packages/core/src/assistant/prompt/layers.ts — the order this renders is that module's `WEB_DOOR_LAYERS` minus its door layer, and the two must not drift.
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
// cm:guard both web doors build their persona HERE and neither keeps its own: `conversation-send.ts` answers the browser and `assistant/routes.ts` answers the SSE surface, and `docs/proposals/api-chat-has-no-client.md` prices two persona assemblies over one store as drift a reader cannot resolve. A second assembly re-introduced anywhere is that cost back (ISS-1007).
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
// cm:guard it is built HERE beside the other two for the reason the Rocket.Chat one is: the three
// arrangements are one file apart, so a layer added to one is visibly absent from the others. What
// differs is the door layer alone (ISS-1039).
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

/**
 * The assistant's voice in a Rocket.Chat room.
 */
// cm:guard the room's own arrangement lives here beside the web app's rather than in the adapter, so the two orders are one file apart and a layer added to one is visibly absent from the other (ISS-1057).
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
