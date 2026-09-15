// What every assistant door says, and what the Forge web doors add to it.
//
// One method reaches every door from ONE module: `guides/assistant-method-guide.ts`
// holds the text and the opening below renders it whole, so a door carries the
// method as part of who it is rather than as something it goes and fetches. A
// channel's own persona is then only what is true of that channel (ISS-1034).

// cm:guard this module parses NO environment and must not start to: `web-door.test.ts` and `conversation-send.test.ts` mock `db/client.js` precisely so that composing a persona needs no env, and an `env` import here makes both fail to COLLECT rather than fail an assertion — a whole file's coverage gone for a string. A door that has a web origin passes it in (ISS-1007).
import { ASSISTANT_METHOD_GUIDE } from '../guides/assistant-method-guide.js';

/** What a door tells `assistantOpening` about itself. */
export interface DoorOpening {
  projectName: string;
  /** A clause completing "answering …" — where this assistant is speaking. */
  venue: string;
  projectSlug?: string | undefined;
  webBaseUrl?: string | undefined;
}

/**
 * The lines every door opens with: who the assistant is, where the method
 * lives, and how to link an issue it cites.
 */
// cm:guard the method body is RENDERED here and no line tells the model to fetch it: ISS-1007 made it a guide so twenty bullets stopped being copied into each persona, and the one copy stays — in `assistant-method-guide.ts` — but a method the model must spend a tool round retrieving is one it can skip, and measured on beta 2026-09-15 the fetch cost a provider round-trip on every turn including "ping" for a 2 ms read of a constant. Delivering the text is what the ISS-1007 guard asked for; fetching was the means, not the end (ISS-1034).
// cm:edge contract -> packages/core/src/guides/assistant-method-guide.ts — the body interpolated below is that module's export, still served by `forge_guide get answering-as-the-assistant` for a reader outside a turn; that module imports only a type, which is what lets this env-free module import it.
export function assistantOpening(door: DoorOpening): string[] {
  return [
    `You are the working assistant for project "${door.projectName}", ${door.venue}.`,
    '',
    ASSISTANT_METHOD_GUIDE.body.trim(),
    '',
    'The lines below add only what is true of this channel.',
    // cm:guard the origin is a PREFIX and an absent one yields a root-relative path rather than dropping the line: a reader in a chat client is outside the product and needs the host, a reader in the app is already on it, and making the whole instruction conditional on an origin is how the web doors silently stopped being told to link an issue at all (ISS-1007).
    ...(door.projectSlug
      ? [
          // cm:guard the line says WHERE the documentId comes from for an issue that already exists, measured on beta 2026-09-15 (ISS-1041): the list `forge issue --status s` prints no documentId, and a model told only the shape lifted numbers from the titles into the path, was refused by the door and sent the fallback.
          `- When you create or cite a Forge issue, include its web link: ${door.webBaseUrl ?? ''}/projects/${door.projectSlug}/issues/<documentId> (\`forge new\` echoes the documentId; for an existing issue \`forge issue ISS-<n>\` prints it — the list does not, so never put a key or a number in its place).`,
        ]
      : []),
  ];
}

/**
 * What is true of the Forge web app and of nowhere else.
 */
// cm:guard it says what this surface CAN do rather than leaving the reader to find out: the Forge UI chat used to be a Claude Code session on a runner with the repository checked out, and a conversation turn reads the project through tools and no working tree. A persona that did not say so would let the same screen answer a question about a file as though it had looked (ISS-1004 step 5).
// cm:guard the slug is INTERPOLATED and never left as a placeholder: the model repeats the route it is given, so a literal `<slug>` in this string is a link a person cannot follow, which is the way-out sentence failing at the one moment it is read (ISS-1005, review F4).
// cm:guard it also names WHERE the runner went, and that sentence is this surface's answer to what it lost: ISS-1005 moved the browser off a paired box on purpose and accepted the loss rather than bridging it, because the only bridge would have meant widening `CHAT_TOOL_ALLOWLIST` past the fence that issue forbids widening. A refusal that names no way out leaves the person to discover for themselves that `/projects/<slug>/agents` is still there and still runs a session on a box, which is the whole of the reach that went (ISS-1005).
export function webDoorLines(projectSlug: string, askedBy: string | null): string[] {
  return [
    ...(askedBy ? [`- You are answering ${askedBy}.`] : []),
    '- You read this project through your tools — its issues, its progress, its knowledge and its memory. You have no checkout of the repository and no shell, so say so plainly when you are asked about a file rather than guessing at its contents.',
    `- You can file a draft issue and comment on one. You CANNOT edit a file, run a command or drive a pipeline: that needs a session on a paired box, which a person starts from this project's Agents screen at /projects/${projectSlug}/agents. Say so, and name that screen, rather than declining without a way forward.`,
    '- Markdown renders here, and the person can reply, so a follow-up question is available to you when one is genuinely needed.',
  ];
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
  return [
    ...assistantOpening({
      projectName,
      venue: 'answering a person in the Forge web app',
      projectSlug,
    }),
    ...webDoorLines(projectSlug, askedBy),
  ].join('\n');
}
