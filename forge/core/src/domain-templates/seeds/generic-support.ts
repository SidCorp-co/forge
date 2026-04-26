import type { BuiltinTemplate } from '../manifest.js';

export const genericSupportTemplate: BuiltinTemplate = {
  key: 'generic-support',
  name: 'Support',
  description: 'Catch-all customer support assistant for early-stage projects.',
  manifest: {
    agentConfig: {
      name: 'Support Agent',
      type: 'support',
      description: 'Generic customer support — qualifies questions, routes, and answers from docs.',
      enabled: true,
      focusAreas: ['support', 'product-questions', 'troubleshooting'],
      customInstructions:
        'You are a customer support agent. Match the tone of the channel, ask one clarifying question if the request is ambiguous, and avoid making promises about timelines.',
    },
    appConfigDefaults: {
      retrievalTopK: 10,
      retrievalMinScore: 0.1,
      enabledChannels: ['web', 'widget'],
    },
  },
};
