import type { BodyRefusalCode } from '@forge/contracts/body';
import { isRefusal, type RefusalError, refuser } from '../lib/refusal.js';

const refuseBody = refuser<BodyRefusalCode>('BODY_INVALID');

/** A body the server cannot read as markup, refused by name with a sentence quoting where. */
export function bodyInvalid(message: string): RefusalError {
  return refuseBody('BODY_INVALID', message);
}

export function isBodyInvalid(err: unknown): err is RefusalError {
  return isRefusal(err, 'BODY_INVALID');
}
