/** The guard a What's new route runs before its read: the reader's time zone, refused by name. */

import type { WhatsNewRefusalCode } from '@forge/contracts/whats-new';
import { refuser } from '../lib/refusal.js';

export const refuseWhatsNew = refuser<WhatsNewRefusalCode>('WHATS_NEW_REFUSED');

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
