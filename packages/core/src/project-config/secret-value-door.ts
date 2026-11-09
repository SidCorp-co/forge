/**
 * Where a testing secret's value is read: one door, `GET /api/jobs/<run id>/testing-profiles/<profile>/secrets`
 * (`testing-secrets-routes.ts`), for the running job or declared run that needs it. The reads an agent
 * reaches for first (the profile, the project's secrets list) name that door with its one secret filled in,
 * and the paths it guesses next refuse by name pointing there, so a judge declared over a profile does
 * not give up at a 404 (dev core, adminhub-api run 194c71e4, 2026-10-30: seven reads, no value, no
 * pointer). None of them serves a value: the door stays the one place a testing value leaves core. A
 * secret declared for acting (REQ-88) is read at its own door, `acting-secret-door.ts`, and the same
 * reads point there for it.
 */

import { HTTPException } from 'hono/http-exception';
import type { TestingProfile } from './policy-schema.js';
import { credentialRefs } from './service.js';

/** What a run substitutes for `<run id>` in the door. */
const RUN_ID_IS =
  '<run id> is the id `forge-runner run declare` gave the run making the call, or `self` under a job’s own credential';

/** Who reads at the acting door, as a pointer to it says. */
const ACTING_READERS_ARE =
  "by the project's master under its box's credential, or a declared run working one of its issues naming itself with ?run=<run id>, as the project document's `actingSecrets` names them";

/** The door for `profileId`, reading the one secret `query` names (`actor=admin`, `ref=secret://…`). */
export function secretValueDoor(profileId: string, query: string): string {
  return `GET /api/jobs/<run id>/testing-profiles/${profileId}/secrets?${query}`;
}

/**
 * The pointer a declared profile's read carries: one door per actor and per service, since a read
 * names the one secret its run needs and is never handed the whole profile (ISS-868).
 */
export function profileValueDoor(profileId: string, profile: TestingProfile) {
  const doors = [
    ...Object.keys(profile.actors).map((a) => secretValueDoor(profileId, `actor=${a}`)),
    ...Object.keys(profile.services).map((s) => secretValueDoor(profileId, `service=${s}`)),
  ];
  const route = secretValueDoor(profileId, 'actor=<actor>');
  return {
    route,
    doors,
    says: `a value is read one actor or service at a time, at ${route} (or service=<service>), by the running job or declared run that judges with it; ${RUN_ID_IS}. No other route serves a value.`,
  };
}

/** Per secret, the door each profile naming its ref reads it at; none where no profile names it. */
export function secretValueDoors(
  profiles: ReadonlyArray<{ profileId: string; document: TestingProfile }>,
  ref: string,
): string[] {
  return profiles
    .filter((p) => credentialRefs(p.document).some((r) => r.ref === ref))
    .map((p) => secretValueDoor(p.profileId, `ref=${ref}`));
}

/** The line a project's secrets list carries: names here, values only at the door. */
export const SECRETS_LIST_SAYS = `this lists names only. A value is read one at a time at GET /api/jobs/<run id>/testing-profiles/<profile>/secrets?ref=<ref>, by the running job or declared run judging with a profile that names the ref (each secret's \`valueAt\`); ${RUN_ID_IS}. A secret declared for acting is read at GET /api/projects/<id>/acting-secrets/<scope>/<name>, ${ACTING_READERS_ARE}. No other route serves a value.`;

/** The door an acting secret's value is read at (REQ-88, `acting-secret-door.ts`). */
export function actingSecretDoor(projectId: string, ref: string): string {
  return `GET /api/projects/${projectId}/acting-secrets/${ref.replace('secret://', '')}`;
}

/** The refusal a guessed value path of an acting secret answers: not here, and where. */
export function actingSecretElsewhere(asked: string, door: string): HTTPException {
  return new HTTPException(404, {
    message: `${asked} serves no secret value. A secret declared for acting is read at ${door}, ${ACTING_READERS_ARE}.`,
    cause: { code: 'ACTING_SECRET_READ_ELSEWHERE' },
  });
}

/** The refusal a guessed value path answers: not here, and where. */
export function secretValueElsewhere(asked: string, door: string): HTTPException {
  return new HTTPException(404, {
    message: `${asked} serves no secret value. A testing secret's value is read at ${door}, by the running job or declared run that judges with it; ${RUN_ID_IS}.`,
    cause: { code: 'TESTING_SECRET_READ_ELSEWHERE' },
  });
}
