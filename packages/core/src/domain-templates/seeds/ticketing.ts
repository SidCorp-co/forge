import type { BuiltinTemplate } from '../manifest.js';

export const ticketingTemplate: BuiltinTemplate = {
  key: 'ticketing',
  name: 'Issue Tracker',
  description: 'Software-team issue tracker template.',
  manifest: {
    agentConfig: {
      name: 'Pipeline Coordinator',
      type: 'ticketing',
      description: 'Coordinates the issue backlog.',
      enabled: true,
      focusAreas: ['triage', 'planning', 'code-review', 'release'],
      customInstructions:
        'You coordinate the issue backlog. Read an issue and its thread before you act on it, and leave status moves to the run that owns the issue.',
    },
    appConfigDefaults: {
      retrievalTopK: 10,
      retrievalMinScore: 0.15,
      enabledChannels: ['web', 'widget'],
    },
  },
};
