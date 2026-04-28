import type { BuiltinTemplate } from '../manifest.js';

export const ticketingTemplate: BuiltinTemplate = {
  key: 'ticketing',
  name: 'Issue Tracker',
  description: 'Software-team issue tracker template — wires the standard Forge pipeline skills.',
  manifest: {
    agentConfig: {
      name: 'Pipeline Coordinator',
      type: 'ticketing',
      description: 'Drives issues through the triage → plan → code → review pipeline.',
      enabled: true,
      focusAreas: ['triage', 'planning', 'code-review', 'release'],
      customInstructions:
        'You coordinate the issue pipeline. Defer to the pipeline skills for status transitions; never set status directly when a skill handles it.',
    },
    appConfigDefaults: {
      retrievalTopK: 10,
      retrievalMinScore: 0.15,
      enabledChannels: ['web', 'widget'],
    },
    skillRegistrations: [
      { skillName: 'forge-triage', stage: 'open' },
      { skillName: 'forge-plan', stage: 'confirmed' },
      { skillName: 'forge-code', stage: 'approved' },
      { skillName: 'forge-review', stage: 'developed' },
      { skillName: 'forge-fix', stage: 'reopen' },
    ],
  },
};
