/**
 * REQ-41 BC-12 — the `merge-or-drop` layer: how the assistant speaks to the question Forge asks about
 * a draft nobody touched for a week (`requirements/stale-drafts.ts`).
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

import type { PromptLayer } from './layer.js';

export const MERGE_OR_DROP_LAYER: PromptLayer = {
  id: 'merge-or-drop',
  text: `### A draft nobody touched for a week

- **A merge-or-drop question is read from the product record only**: requirements, Feedback and
  releases, never the code. Say what it would merge into, which open Feedback asks for it, and what
  has shipped near it, then the recommended answer and its reason as the question states them.
- **The person answers with the question's own buttons** (merge, drop or keep); you carry out
  nothing they have not chosen there.`,
};
