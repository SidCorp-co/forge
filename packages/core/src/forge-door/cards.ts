// The capability card of the Forge feedback door's REST act no MCP action twins (ISS-1251): the
// claim the forge-runner hook makes for a reporter's session, beside its route (`routes.ts`) and
// built into the door catalog by `mcp/rest-cards.ts`. Written from the claim's use on forge
// (11,627 claims in 30 days to 2026-11-16, every one the hook's) and the feedback guide's account.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const FORGE_DOOR_REST_CARDS = {
  'POST /api/forge/feedback/answers/claim': {
    purpose: 'Hands a reporter’s session each answer on its Forge feedback it was not told yet, once.',
    situations: [
      {
        when: 'an FB-n you filed about Forge was answered and your session was not told',
        do: 'let the forge-runner hook claim it on your next prompt; read what it tells you and act on it',
      },
      {
        when: 'the hook cannot run (no forge-runner on the box) and you wait on an answer',
        do: 'claim once with {} and read each answer it returns',
      },
    ],
    practice: [
      'Each answer is told once: a claim takes it, so a second caller is told nothing.',
      'An answer is for you, not the project’s channel: act on it or reply with feedback.reply.',
    ],
    example: {},
    // the hook tells each claimed answer with one line not to post it in the project channel, which
    // sessions had done; every claim on forge in the window was the hook's, none refused
    redFlag:
      'Polling the claim by hand beside the hook, or posting a claimed answer in the project channel.',
    family: 'forge-feedback',
    audience: ['master', 'run'],
  },
} satisfies Record<string, CapabilityCardBody>;
