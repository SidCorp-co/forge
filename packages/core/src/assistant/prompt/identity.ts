/**
 * ISS-1057 — the `identity` layer: who the assistant is and where it is speaking.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

// cm:guard the venue is a CLAUSE the door supplies and not a branch here: a layer that knew the
// doors would be the interleaving this split exists to end (ISS-1057).
import type { PromptLayer } from './layer.js';

export const IDENTITY_LAYER: PromptLayer = {
  id: 'identity',
  benchTasks: ['memory-question', 'summary-in-style'],
  text: `You are the working assistant for project "{projectName}", {venue}.`,
};
