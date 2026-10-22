import { BASE_LAYER } from './base.js';
import { BA_DOOR_LAYER } from './door-ba.js';
import { BA_FIRST_DOOR_LAYER } from './door-ba-first.js';
import { ROCKETCHAT_DOOR_LAYER } from './door-rocketchat.js';
import { WEB_DOOR_LAYER } from './door-web.js';
import { WEB_AGENT_DOOR_LAYER } from './door-web-agent.js';
import { WIDGET_DOOR_LAYER } from './door-widget.js';
import { IDENTITY_LAYER } from './identity.js';
import type { PromptLayer } from './layer.js';
import { LINKING_LAYER } from './linking.js';
import { TOOLS_LAYER } from './tools.js';
export const METHOD_LAYERS: readonly PromptLayer[] = [BASE_LAYER, TOOLS_LAYER];

/** What every door renders before its own layer. */
const OPENING: readonly PromptLayer[] = [IDENTITY_LAYER, BASE_LAYER, TOOLS_LAYER, LINKING_LAYER];

export const WEB_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, WEB_DOOR_LAYER];
export const WEB_AGENT_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, WEB_AGENT_DOOR_LAYER];
export const ROCKETCHAT_DOOR_LAYERS: readonly PromptLayer[] = [...OPENING, ROCKETCHAT_DOOR_LAYER];
/** The BA door: who it is and its narrow role, without the tracker method the other doors carry. */
export const BA_DOOR_LAYERS: readonly PromptLayer[] = [IDENTITY_LAYER, BA_DOOR_LAYER];
export const BA_FIRST_DOOR_LAYERS: readonly PromptLayer[] = [IDENTITY_LAYER, BA_FIRST_DOOR_LAYER];
/**
 * The feedback widget: its own layer and nothing else, because every other layer speaks of the
 * project, its tracker or its tools, and a visitor's assistant knows none of them.
 */
export const WIDGET_DOOR_LAYERS: readonly PromptLayer[] = [WIDGET_DOOR_LAYER];
