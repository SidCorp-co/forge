import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import type { ForgeGuide } from './types.js';

/** The one spelling of this guide's slug. Every door persona points at it. */
export const ASSISTANT_METHOD_SLUG = 'answering-as-the-assistant';

export const ASSISTANT_METHOD_GUIDE: ForgeGuide = {
  slug: ASSISTANT_METHOD_SLUG,
  audience: 'agent',
  title: 'Answering as the assistant',
  summary:
    'How a Forge assistant works a request: investigate with your tools before answering, act on what you are asked instead of delegating, write to the tracker only when asked, and what a reply and a filed issue owe.',
  version: 3,
  body: composeLayers(METHOD_LAYERS),
};
