// The capability cards of the report doors a person's assistant runs (ISS-1251), beside their routes
// (`routes.ts`), keyed by the door as the published contract lists it and built into the door catalog
// by `mcp/rest-cards.ts`. Written from the one agent call each took on forge (2026-10-21).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const REPORT_REST_CARDS = {
  'POST /api/projects/:id/report-templates/:templateId/runs': {
    purpose: 'Runs a saved report template as the asker, keeping its frame for 30 days.',
    situations: [
      {
        when: 'a person asks for a report a template already draws',
        do: 'run the template with its params; each of its queries runs under the asker’s own grants',
      },
    ],
    practice: [
      'A query the asker may not run is refused by name: the report never widens their reach.',
    ],
    example: { params: {} },
    // forge: its one call in the window landed, a master probing it
    redFlag: 'Running a template to read data the asker cannot reach: its queries run as them.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['a report template run by a master probing it'],
  },
  'POST /api/projects/:id/executions': {
    purpose: 'Runs a script over a turn’s report runs on the project’s sandbox executor.',
    situations: [
      {
        when: 'a person’s report needs a computation its queries cannot do',
        do: 'run a script over the run ids as inputs, within the sandbox’s limits',
      },
    ],
    practice: ['It takes assistant.exec; the script sees only the runs it names.'],
    example: { language: 'javascript', script: 'return inputs.length;', inputs: ['run_1'] },
    // forge: the one agent call was forbidden (assistant.exec)
    redFlag: 'An agent running scripts here to compute what it can compute in its own session.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['a script run by an agent in the person’s sandbox, forbidden'],
  },
} satisfies Record<string, CapabilityCardBody>;
