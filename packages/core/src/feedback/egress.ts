import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import type { ActorAgency } from '@forge/contracts/permissions';
import { type EgressReader, egressReading } from '../lib/data-egress.js';

export const WITHHELD =
  'content withheld: this project keeps its data out of every provider (no_egress)';

export type ReadDoor = Pick<EgressReader, 'providerBound'>;

// cm:guard every provider-bound feedback read passes `lib/data-egress.ts:egressReading`
export function feedbackEgress(
  level: SensitiveDataLevel,
  agency: ActorAgency,
  door: ReadDoor = {},
) {
  return egressReading(level, { agency, providerBound: door.providerBound }, 'feedback');
}
