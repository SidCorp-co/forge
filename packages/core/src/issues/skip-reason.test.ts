/**
 * ISS-1189 — "no deployment contains the change" stops being a reason to skip a criterion on a
 * project whose preview is local. Local IS the preview there.
 *
 * Every string below is a `why` a real judging run wrote on this tracker, not a paraphrase. The
 * two halves are the whole point: the first is the absence a local preview answers, the second is
 * an absence it does not, and a rule that could not tell them apart would make runs claim a route
 * they do not have. The issue named all six skipped criteria as one set; read back, they are two.
 */

import { describe, expect, it } from 'vitest';
import { namesNoDeployment } from './skip-reason.js';

/** ISS-1152, judged at 382502c884 — the change was in no deployment at all. */
const ABSENCE_A_LOCAL_PREVIEW_ANSWERS = {
  'ISS-1152 c12':
    'No route: the change is not running anywhere. Live core at judging time reports sourceCommit ' +
    '97bcf13c1 (uptime 41.8ks, started before the 18:59Z merge) and 382502c884 is not an ancestor ' +
    'of it, so no deployment can dispatch a landing deploy.',
  'ISS-1152 c13':
    'No route, same cause as 12: there is no deployment containing this change for a judging run ' +
    'to exercise, so no derived commit could be cited.',
  'ISS-1152 c14':
    'No route to the screen: the toggle ships in packages/web-v2 at 382502c884 and the running ' +
    'product predates it, so nobody could render the Coolify settings section.',
};

/** ISS-1114 and ISS-1118 — a separately installed binary, and a box that refuses work. */
const ABSENCE_A_LOCAL_PREVIEW_DOES_NOT_ANSWER = {
  'ISS-1114 c13':
    'No route reached it. The criterion is about the daemon log on the sweep that starts a pane, ' +
    'and the daemon on this box (pid 2939476, /home/dev/.local/bin/forge-runner) is built from ' +
    'code that predates this change - it carries none of the five brief literals.',
  'ISS-1118':
    'No route at the deployment identity. These four are properties of the forge-runner daemon ' +
    'and CLI, a separately installed binary that the identity I was given (33637c6, the API and ' +
    'web build, confirmed at /version and on the page’s own Sentry release tag) does not name.',
  'ISS-1139 c16':
    'Not reachable at this deployment: the runner half ships in the forge-runner binary, not in ' +
    'the API. Both boxes online report agent_version 0.17.0.',
  'a criterion nobody could reach for want of a credential':
    'No route: the QA account is not a member of this organisation, so the screen the criterion ' +
    'names cannot be opened at all.',
};

describe('a `why` that says no deployment carries the change', () => {
  for (const [name, why] of Object.entries(ABSENCE_A_LOCAL_PREVIEW_ANSWERS)) {
    it(`reads ${name} as an absence a local preview answers`, () => {
      expect(namesNoDeployment(why)).toBe(true);
    });
  }
});

describe('a `why` that says something else is absent', () => {
  for (const [name, why] of Object.entries(ABSENCE_A_LOCAL_PREVIEW_DOES_NOT_ANSWER)) {
    it(`leaves ${name} alone`, () => {
      expect(namesNoDeployment(why)).toBe(false);
    });
  }
});
