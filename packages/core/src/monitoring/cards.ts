// The capability card of the monitoring door a project's master calls over REST (ISS-1251), beside
// its route (`project-routes.ts`), keyed by the door as the published contract lists it and built
// into the door catalog by `mcp/rest-cards.ts`. Written from the monitoring guide and ISS-1225, which
// moved production monitoring onto the Prometheus integration.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const MONITORING_REST_CARDS = {
  'POST /api/projects/:id/monitoring/agent-token': {
    purpose: 'Mints the token a project’s host agent pushes its internal metrics to Forge with.',
    situations: [
      {
        when: 'a port the monitoring server cannot reach must be watched on the project’s host',
        do: 'mint the token as a project admin and put it in a file on the host, readable by the agent only',
      },
    ],
    practice: [
      'It is shown once and a new one replaces the old; the agent runs on the host, never in the repo.',
    ],
    example: {},
    family: 'setup',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
