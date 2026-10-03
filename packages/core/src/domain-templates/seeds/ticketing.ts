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
      // Registered at the statuses a run starts from. Planning and review are steps inside
      // `in_progress` (ISS-54), which no status names, so they have no stage of their own here.
      { skillName: 'forge-triage', stage: 'open' },
      { skillName: 'forge-code', stage: 'approved' },
      { skillName: 'forge-fix', stage: 'reopen' },
    ],
  },
};
