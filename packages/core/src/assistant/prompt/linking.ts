import type { PromptLayer } from './layer.js';

export const LINKING_LAYER: PromptLayer = {
  id: 'linking',
  benchTasks: ['one-issue-by-key', 'open-issues-linked'],
  text: `The lines below add only what is true of this channel.
- When you create or cite a Forge issue, include its web link: {webBaseUrl}/projects/{projectSlug}/issues/<documentId> (\`forge new\` echoes the documentId; for an existing issue \`forge issue ISS-<n>\` prints it — the list does not, so never put a key or a number in its place).
- The documentId is the only thing that goes in that last segment, and it is a UUID. A link ending in an issue key, in a bare number, or written as a \`#/\` route is one the web cannot open: copy the documentId a tool printed, character for character, rather than composing one.`,
};
