/**
 * ISS-1057 — the `door-web` layer: what is true of the Forge web app and of nowhere else.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

// cm:guard it says what this surface CAN do rather than leaving the reader to find out: the Forge
// UI chat used to be a Claude Code session on a runner with the repository checked out, and a
// conversation turn reads the project through tools and no working tree. A persona that did not
// say so would let the same screen answer a question about a file as though it had looked
// (ISS-1004 step 5).
// cm:guard the slug is INTERPOLATED and never left as a placeholder in the rendered text: the model
// repeats the route it is given, so a literal `<slug>` reaching a reader is a link a person cannot
// follow, which is the way-out sentence failing at the one moment it is read (ISS-1005, review F4).
// cm:guard it also names WHERE the runner is, and that sentence is this surface's answer to what
// this mode cannot do. ISS-1005 moved the browser off a paired box and accepted the loss; ISS-1039
// took it back as a MODE rather than as a widening — a conversation opened in Agent mode runs on a
// paired box, and `CHAT_TOOL_ALLOWLIST` is exactly what it was, which is the fence ISS-1005 forbids
// widening and this layer still lives inside. So the way out named here is the nearest one a person
// can take from the screen they are on, and the Agents screen is named second because a room's mode
// is settled by its first send and this room's is already Assistant (ISS-1039).
// cm:edge contract -> packages/web-v2/src/features/session/runner-surface-named.test.ts — that test
// reads THIS FILE by path and asserts the Agents route below is still named, because web-v2 cannot
// import core's source and a path read is the only shape this cross-package contract has. It is
// also invisible to `pnpm test:changed`, whose graph follows imports, which is why CLAUDE.md says
// `pnpm test` before you push. This back-pointer is what puts an edit to this file in the codemap
// PR comment, so the coupling is visible from both ends rather than only from the test (ISS-1057).
import type { PromptLayer } from './layer.js';

export const WEB_DOOR_LAYER: PromptLayer = {
  id: 'door-web',
  benchTasks: ['out-of-reach-tests', 'preference-bullets', 'memory-followup'],
  text: `- You are answering {askedBy}.
- You read this project through your tools — its issues, its progress, its knowledge and its memory. You have no checkout of the repository and no shell, so say so plainly when you are asked about a file rather than guessing at its contents.
- You can file a draft issue and comment on one. You CANNOT edit a file, run a command or drive a pipeline: that needs a session on a paired box, which this project reaches two ways — a fresh conversation opened in Agent mode, picked in the composer before its first message, or the Agents screen at /projects/{projectSlug}/agents. Say so, and name the first of those, rather than declining without a way forward.
- Markdown renders here, and the person can reply, so a follow-up question is available to you when one is genuinely needed.`,
};
