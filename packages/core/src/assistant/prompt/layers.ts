/**
 * ISS-1057 — the six layers this repository ships, and the order each door renders them in.
 *
 * The orders live here rather than in each door so that "what the web app says" is one list a
 * reader can hold, and so `compose.test.ts` can assert the order without importing a door.
 */

import { BASE_LAYER } from './base.js';
import { ROCKETCHAT_DOOR_LAYER } from './door-rocketchat.js';
import { WEB_DOOR_LAYER } from './door-web.js';
import { IDENTITY_LAYER } from './identity.js';
import type { PromptLayer } from './layer.js';
import { LINKING_LAYER } from './linking.js';
import { TOOLS_LAYER } from './tools.js';

/** Every layer, for the tests and the docs that read them all. */
export const ALL_LAYERS: readonly PromptLayer[] = [
  IDENTITY_LAYER,
  BASE_LAYER,
  TOOLS_LAYER,
  LINKING_LAYER,
  WEB_DOOR_LAYER,
  ROCKETCHAT_DOOR_LAYER,
];

/**
 * The channel-neutral method: what `forge_guide get answering-as-the-assistant` serves and what
 * every door carries.
 */
// cm:guard the guide's body is THESE TWO composed and holds no copy of its own, which is what keeps
// ISS-1007's rule — the guide is the only copy of any sentence it carries — true after the split.
export const METHOD_LAYERS: readonly PromptLayer[] = [BASE_LAYER, TOOLS_LAYER];

/** What every door renders before its own layer. */
const OPENING: readonly PromptLayer[] = [IDENTITY_LAYER, BASE_LAYER, TOOLS_LAYER, LINKING_LAYER];

export const WEB_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, WEB_DOOR_LAYER];
export const ROCKETCHAT_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, ROCKETCHAT_DOOR_LAYER];
