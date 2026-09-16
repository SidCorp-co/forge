// The method every assistant door follows, stored once.
//
// It lives in its own module for the reason `conformance-guide.ts` does —
// `registry.ts` aggregates the tiers and a body this size inside it buys
// nothing — and it imports only the guide type, because `registry.ts` may reach
// no DB, env or side effect and this file is imported by it.

// cm:edge contract -> scripts/check-injected-doc-modes.mjs — that gate reads guide bodies by FILE, and its own guard says a surface it does not list is injected text nobody checks. This file is listed there; a third guide module must be added there in the change that creates it.
import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import type { ForgeGuide } from './types.js';

/** The one spelling of this guide's slug. Every door persona points at it. */
// cm:guard this is the only place the slug is written down, and a rename has to reach every door persona interpolating it in the same change — a persona left on the old string sends the model to a guide that answers NOT_FOUND, which reads as "there is no such method" rather than as a broken pointer (ISS-1007).
export const ASSISTANT_METHOD_SLUG = 'answering-as-the-assistant';

// cm:guard the body is COMPOSED from `assistant/prompt/base.ts` and `assistant/prompt/tools.ts` and holds no copy of its own: ISS-1057 split the method into layers so a change to the tool rules is a change to one file with its own benchmark tasks named on it, and a body written out here again would be the second copy ISS-1007 removed.
// cm:guard the body is channel-neutral by construction and that is the whole point of the tier: a sentence true only in a chat room, only in the browser, or only of one project's language belongs in that door's own layer or in `agentConfig.personaStyle`, because a channel fact added here reaches every door including the ones that make it false (ISS-1007).
// cm:edge contract -> packages/core/src/assistant/prompt/base.ts
// cm:edge contract -> packages/core/src/assistant/prompt/tools.ts
export const ASSISTANT_METHOD_GUIDE: ForgeGuide = {
  slug: ASSISTANT_METHOD_SLUG,
  title: 'Answering as the assistant',
  summary:
    'How a Forge assistant works a request: investigate with your tools before answering, act instead of delegating, and what a reply and a filed issue owe.',
  version: 2,
  body: composeLayers(METHOD_LAYERS),
};
