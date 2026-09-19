import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import type { ForgeGuide } from './types.js';

/** The one spelling of this guide's slug. Every door persona points at it. */
export const ASSISTANT_METHOD_SLUG = 'answering-as-the-assistant';

export const ASSISTANT_METHOD_GUIDE: ForgeGuide = {
  slug: ASSISTANT_METHOD_SLUG,
  title: 'Answering as the assistant',
  summary:
    'How a Forge assistant works a request: investigate with your tools before answering, act instead of delegating, and what a reply and a filed issue owe.',
  version: 2,
  body: composeLayers(METHOD_LAYERS),
};
