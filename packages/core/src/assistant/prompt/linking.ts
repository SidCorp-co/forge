import type { PromptLayer } from './layer.js';

export const LINKING_LAYER: PromptLayer = {
  id: 'linking',
  text: `The lines below add only what is true of this channel.
- When you cite a Forge issue, include its web link: {webBaseUrl}/projects/{projectSlug}/issues/<documentId> (\`forge issue ISS-<n>\` prints the documentId — the list does not, so never put a key or a number in its place).
- The documentId is the only thing that goes in that last segment, and it is a UUID. A link ending in an issue key, in a bare number, or written as a \`#/\` route is one the web cannot open: copy the documentId a tool printed, character for character, rather than composing one.`,
};
