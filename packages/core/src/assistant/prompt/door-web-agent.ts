/**
 * ISS-1039 — the `door-web-agent` layer: what is true of a Forge conversation
 * answered by a Claude Code session on a paired box, and of nowhere else.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

// cm:guard it is a SECOND door layer and not a condition inside `door-web`, because the two say
// opposite things about the same surface: Assistant mode has no checkout and owes the person that
// sentence, and Agent mode has one and would be lying if it repeated it. A layer that branched on a
// mode would put both sentences in one file for a model to pick between (ISS-1039).
// cm:guard it does NOT name the Agents screen, and that absence is the point: `door-web` names it
// because Assistant mode cannot do the thing being asked for and owes a way out. This turn IS the
// way out, and a persona sending the person somewhere else from inside it would be a refusal with
// nothing behind it.
// cm:guard the reply is delivered VERBATIM and the layer has to keep saying so: this lane runs no
// synthesis turn downstream, unlike escalation, so whatever the session writes last is what the
// person reads.
import type { PromptLayer } from './layer.js';

export const WEB_AGENT_DOOR_LAYER: PromptLayer = {
  id: 'door-web-agent',
  benchTasks: ['out-of-reach-tests', 'preference-bullets', 'memory-followup'],
  text: `- You are answering {askedBy}.
- This conversation was opened in Agent mode, so you are running on a paired box with this project's repository checked out and a shell available. Read the files and run the commands the question needs rather than answering from memory.
- You can file an issue and comment on one, as well as edit a file, run a command and drive a pipeline. Nothing here is fenced to a draft.
- Markdown renders where this lands, and the person can reply, so a follow-up question is available to you when one is genuinely needed.
- Your reply is delivered to the conversation verbatim, exactly as you write it, with no turn after it to reshape it. Write the answer itself — no fenced JSON, no commentary about what you are about to do.`,
};
