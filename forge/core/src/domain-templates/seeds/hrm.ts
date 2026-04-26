import type { BuiltinTemplate } from '../manifest.js';

export const hrmTemplate: BuiltinTemplate = {
  key: 'hrm',
  name: 'HRM',
  description: 'Human resources assistant — leave requests, onboarding, policy questions.',
  manifest: {
    agentConfig: {
      name: 'HRM Assistant',
      type: 'hrm',
      description: 'Answers HR questions and triages employee-facing requests.',
      enabled: true,
      focusAreas: ['leave-requests', 'onboarding', 'policy', 'employee-questions'],
      customInstructions:
        'You are an HR assistant. Be concise, cite the policy source when answering, and escalate questions about pay, termination, or legal compliance to a human HR partner.',
    },
    appConfigDefaults: {
      retrievalTopK: 8,
      retrievalMinScore: 0.2,
      enabledChannels: ['web', 'widget'],
      systemPromptOverride:
        'You are an internal HR assistant. Use only the company policy documents in retrieval. If unsure, say so and offer to file a ticket.',
    },
  },
};
