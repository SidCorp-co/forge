/**
 * Where a testing secret's value is read: one door, `GET /api/jobs/<run id>/testing-profiles/<profile>/secrets`
 * (`testing-secrets-routes.ts`), for the running job or declared run that needs it. The reads an agent
 * reaches for first (the profile, the project's secrets list) name that door with the refs filled in,
 * and the paths it guesses next refuse by name pointing there, so a judge declared over a profile does
 * not give up at a 404 (dev core, adminhub-api run 194c71e4, 2026-10-30: seven reads, no value, no
 * pointer). None of them serves a value: the door stays the one place a value leaves core.
 */

import { HTTPException } from 'hono/http-exception';
import type { TestingProfile } from './policy-schema.js';
import { credentialRefs } from './service.js';

/** What a run substitutes for `<run id>` in the door. */
const RUN_ID_IS =
  '<run id> is the id `forge-runner run declare` gave the run making the call, or `self` under a job’s own credential';

/** The door for `profileId`, asking `refs` (every ref the profile names where empty). */
export function secretValueDoor(profileId: string, refs: readonly string[]): string {
  const query = refs.length > 0 ? `?${refs.map((r) => `ref=${r}`).join('&')}` : '';
  return `GET /api/jobs/<run id>/testing-profiles/${profileId}/secrets${query}`;
}

/** The pointer a declared profile's read carries: the door with its refs, and what fills it. */
export function profileValueDoor(profileId: string, profile: TestingProfile) {
  const refs = [...new Set(credentialRefs(profile).map((r) => r.ref))];
  return {
    route: secretValueDoor(profileId, refs),
    says: `the values behind this profile's credentials are read at ${secretValueDoor(profileId, refs)}, by the running job or declared run that judges with them; ${RUN_ID_IS}. No other route serves a value.`,
  };
}

/** Per secret, the door each profile naming its ref reads it at; none where no profile names it. */
export function secretValueDoors(
  profiles: ReadonlyArray<{ profileId: string; document: TestingProfile }>,
  ref: string,
): string[] {
  return profiles
    .filter((p) => credentialRefs(p.document).some((r) => r.ref === ref))
    .map((p) => secretValueDoor(p.profileId, [ref]));
}

/** The line a project's secrets list carries: names here, values only at the door. */
export const SECRETS_LIST_SAYS = `this lists names only. A value is read at GET /api/jobs/<run id>/testing-profiles/<profile>/secrets?ref=<ref>, by the running job or declared run judging with a profile that names the ref (each secret's \`valueAt\`); ${RUN_ID_IS}. No other route serves a value.`;

/** The refusal a guessed value path answers: not here, and where. */
export function secretValueElsewhere(asked: string, door: string): HTTPException {
  return new HTTPException(404, {
    message: `${asked} serves no secret value. A testing secret's value is read at ${door}, by the running job or declared run that judges with it; ${RUN_ID_IS}.`,
    cause: { code: 'TESTING_SECRET_READ_ELSEWHERE' },
  });
}
