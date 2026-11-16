// The capability cards of the schedule doors a master calls over REST (ISS-1251), beside their routes
// (`routes.ts`), keyed by the door as the published contract lists it and built into the door catalog
// by `mcp/rest-cards.ts`. Written from the script-schedules guide and the schedules masters turned on
// and ran on forge.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;
const PROJECT = '0b8e6f4a-2c1d-4e3f-9a5b-7c6d8e9f0a1b';

export const SCHEDULE_REST_CARDS = {
  'POST /api/schedules': {
    purpose:
      'Turns on a recurring job for a project: a script, a prompt session or a report, on a cron.',
    situations: [
      {
        when: 'a business read no standard tool does must run on a clock (orders stuck past their window)',
        do: 'create a script schedule as the project’s master, declaring each read-only ops call it makes',
      },
      {
        when: 'a project wants a daily or weekly summary of how it stands',
        do: 'create a status_report or prompt schedule on the cron it asks for',
      },
    ],
    practice: [
      'A script files a breach only when the previous firing saw it too, under a stable signalKey.',
      'Every ops call is declared read-only; anything that can write is refused at save.',
    ],
    example: {
      projectId: PROJECT,
      name: 'Orders stuck past their window',
      cron: '*/15 * * * *',
      kind: 'script',
      script: 'const r = await ctx.forge.get("/api/version"); ctx.log(r.status);',
    },
    // buy-before-build (forge ISS-1225): production monitoring hand-rolled as watch scripts
    redFlag:
      'Writing up, latency, error or disk monitoring as a script: that is the Prometheus integration’s.',
    audience: ['master'],
    changed: CHANGED,
  },
  'PUT /api/schedules/:id': {
    purpose:
      'Changes a schedule whole: its cron, its script or prompt, its declared calls, on or off.',
    situations: [
      {
        when: 'a schedule’s check, threshold or cron must change, or it should stop for now',
        do: 'put it with the change, or enabled false to stop it without losing its state',
      },
    ],
    practice: [
      'A declaration that stops reading fails each firing by name before the script runs.',
    ],
    example: { enabled: false },
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/schedules/:id/run': {
    purpose: 'Fires a schedule once now, outside its cron, and records the fire like any other.',
    situations: [
      {
        when: 'you just turned a schedule on or changed it',
        do: 'run it once and read its fire: every call answered, nothing filed',
      },
      {
        when: 'you planted a breach to prove a script files it',
        do: 'run it twice: the second firing files one item, a third joins nothing new; then put the threshold back',
      },
    ],
    practice: [
      'Read the fire’s record, not the answer: GET …/automation/fires/:fireId keeps every call and filing.',
    ],
    example: {},
    audience: ['master'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
