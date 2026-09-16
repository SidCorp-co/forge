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
// cm:guard it also names WHERE the runner went, and that sentence is this surface's answer to what
// it lost: ISS-1005 moved the browser off a paired box on purpose and accepted the loss rather than
// bridging it, because the only bridge would have meant widening `CHAT_TOOL_ALLOWLIST` past the
// fence that issue forbids widening (ISS-1005).
import type { PromptLayer } from './layer.js';

export const WEB_DOOR_LAYER: PromptLayer = {
  id: 'door-web',
  benchTasks: ['out-of-reach-tests', 'preference-bullets', 'memory-followup'],
  text: `- You are answering {askedBy}.
- You read this project through your tools — its issues, its progress, its knowledge and its memory. You have no checkout of the repository and no shell, so say so plainly when you are asked about a file rather than guessing at its contents.
- You can file a draft issue and comment on one. You CANNOT edit a file, run a command or drive a pipeline: that needs a session on a paired box, which a person starts from this project's Agents screen at /projects/{projectSlug}/agents. Say so, and name that screen, rather than declining without a way forward.
- Markdown renders here, and the person can reply, so a follow-up question is available to you when one is genuinely needed.`,
};
