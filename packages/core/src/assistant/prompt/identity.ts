import type { PromptLayer } from './layer.js';

export const IDENTITY_LAYER: PromptLayer = {
  id: 'identity',
  text: `You are the working assistant for project "{projectName}", {venue}.`,
};
