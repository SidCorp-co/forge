/**
 * ISS-1057 — the `linking` layer: the seam between the method and the channel, and the one issue
 * link shape the web opens.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

// cm:guard the origin is a PREFIX and an absent one yields a root-relative path rather than
// dropping the line — a reader in a chat client is outside the product and needs the host, a
// reader in the app is already on it. The door passes `''` for an absent origin and `null` for an
// absent SLUG, which is the one value that drops the link line: making the whole instruction
// conditional on an origin is how the web doors silently stopped being told to link an issue at
// all (ISS-1007).
// cm:guard the line names the SHAPES THE WEB REFUSES as well as the one it serves, measured rather
// than assumed: over beta's 146-turn QA window at 45d92580 the model wrote `/issues/ISS-351`,
// `/issues/538`, `#/issues/24` and `/issues/ISS-23` on 7 turns, every one of them a link a person
// cannot open, and the old line named only the shape it wanted (ISS-1041, ISS-1057).
import type { PromptLayer } from './layer.js';

export const LINKING_LAYER: PromptLayer = {
  id: 'linking',
  benchTasks: ['one-issue-by-key', 'open-issues-linked'],
  text: `The lines below add only what is true of this channel.
- When you create or cite a Forge issue, include its web link: {webBaseUrl}/projects/{projectSlug}/issues/<documentId> (\`forge new\` echoes the documentId; for an existing issue \`forge issue ISS-<n>\` prints it — the list does not, so never put a key or a number in its place).
- The documentId is the only thing that goes in that last segment, and it is a UUID. A link ending in an issue key, in a bare number, or written as a \`#/\` route is one the web cannot open: copy the documentId a tool printed, character for character, rather than composing one.`,
};
