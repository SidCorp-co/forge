// The scenarios of the Forge Box doors (ISS-1276, `boxes/tool.ts`). The doors are new, so no agent
// call is on record yet; each scenario is the situation the issue measured or recorded (ISS-1276's
// evidence, sid-xeon-1, 2026-11-17), with the good use its card teaches.

import type { CardScenario } from '../lessons/index.js';

const ISSUE = 'ISS-1276, 2026-11-17 (sid-xeon-1 measurements and the owner’s brief)';

export const BOX_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a UI test a judge recorded by hand with pnpm clip',
    card: 'box.open',
    source: `${ISSUE}: judges ran pnpm clip by hand and nobody could watch an agent's UI session`,
    situation: 'A run must judge a criterion that shows on a screen of the product',
    bad: 'the run drove a private Playwright script and recorded a clip by hand',
    good: 'open a box with the issue and criterion and drive it with forge-runner box act',
    teaches: [
      /open a box in its mode with the issue and criterion/i,
      /instead of ad-hoc Playwright/i,
    ],
  },
  {
    name: 'an agent click while a person held the box',
    card: 'box.act',
    source: `${ISSUE}: agent-browser ran the agent's commands at 13–158 ms while a person clicked, with no lock`,
    situation: 'A person took control of the box the run was driving',
    bad: "the agent's click landed in the middle of the person's input and moved the counter",
    good: 'wait and read until the box reads agent again, then read what the person did',
    teaches: [/wait and read/i, /\?by=person/, /never retry the write in a loop/i],
  },
  {
    name: "a criterion's span marked on a box",
    card: 'box.span',
    source: `${ISSUE}: a verdict owes a clip (VERDICT_CLIP_REQUIRED) that a judge cut by hand`,
    situation: 'The run is about to show criterion 2 on its box',
    good: "mark the span's start, show it, mark its end, and cite the attached clip",
    teaches: [/mark the criterion's span start/i, /cite the attached clip/i],
  },
  {
    name: 'a box that waited on CPU pressure, read until it ran',
    card: 'box.read',
    source: `${ISSUE}: at the limit a request waits, and the wait is visible (owner: at the limit, a request waits)`,
    situation:
      'An open answered BOX_SLOT_UNAVAILABLE: the box waits 2nd because CPU pressure is over the ceiling',
    bad: 'a second box opened for the same criterion while the first waited',
    good: 'read it until it stands at agent; it starts on its own',
    teaches: [/read it until it stands at agent/i, /never open a second one/i],
  },
  {
    name: 'a box closed once its criterion was shown',
    card: 'box.close',
    source: `${ISSUE}: the device's room is shared by every box request; a box left open holds it`,
    situation: 'Every criterion the box was opened for is shown and attached',
    good: 'close the box so its room goes to the next request',
    teaches: [/close the box/i],
  },
];
