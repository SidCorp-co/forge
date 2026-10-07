/**
 * The guards a What's new route runs before its read or write, each throwing its refusal by name:
 * the platform project the instance names, the reader's time zone, and the week a path names.
 */

import { resolveWeek, WEEK_SHAPE, type WhatsNewRefusalCode } from '@forge/contracts/whats-new';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';

export const refuseWhatsNew = refuser<WhatsNewRefusalCode>('WHATS_NEW_REFUSED');

const UNSET =
  "no project is Forge's own on this instance: FORGE_PLATFORM_PROJECT_ID is unset, so What's new has no releases to read. An operator sets it to the uuid of the project Forge itself is built in.";

/** The platform project's id, read from the environment; refused by name where it is unset. */
export function platformProjectId(configured: string | undefined = env.FORGE_PLATFORM_PROJECT_ID): string {
  if (!configured) throw refuseWhatsNew('WHATS_NEW_PLATFORM_UNSET', UNSET);
  return configured;
}

/** An IANA time zone the runtime knows, or a refusal naming the one it does not. */
export function timeZoneOf(text: string | undefined): string {
  const zone = text ?? 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw refuseWhatsNew(
      'WHATS_NEW_TIME_ZONE_UNKNOWN',
      `tz ${JSON.stringify(zone)} is not an IANA time zone this server knows, such as Asia/Ho_Chi_Minh or UTC`,
    );
  }
}

/** The ISO week a path names, resolved against `now`. */
export function weekOf(text: string, now: Date): string {
  const week = resolveWeek(text, now);
  if (!week) {
    throw refuseWhatsNew('WHATS_NEW_WEEK_INVALID', `${JSON.stringify(text)} is not a week: it is ${WEEK_SHAPE}`);
  }
  return week;
}
