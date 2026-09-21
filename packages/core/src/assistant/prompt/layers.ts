import { BASE_LAYER } from './base.js';
import { ROCKETCHAT_DOOR_LAYER } from './door-rocketchat.js';
import { WEB_DOOR_LAYER } from './door-web.js';
import { WEB_AGENT_DOOR_LAYER } from './door-web-agent.js';
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
  WEB_AGENT_DOOR_LAYER,
  ROCKETCHAT_DOOR_LAYER,
];

export const METHOD_LAYERS: readonly PromptLayer[] = [BASE_LAYER, TOOLS_LAYER];

/** What every door renders before its own layer. */
const OPENING: readonly PromptLayer[] = [IDENTITY_LAYER, BASE_LAYER, TOOLS_LAYER, LINKING_LAYER];

export const WEB_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, WEB_DOOR_LAYER];
export const WEB_AGENT_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, WEB_AGENT_DOOR_LAYER];
export const ROCKETCHAT_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, ROCKETCHAT_DOOR_LAYER];
