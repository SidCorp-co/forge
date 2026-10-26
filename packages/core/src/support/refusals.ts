import type { SupportRefusal, SupportRefusalCode } from '@forge/contracts/support';
import { refuser } from '../lib/refusal.js';

export type Refusal = SupportRefusal;

/** One refusal a support service answers, at a path of the request. */
export const refusalOf = (
  code: SupportRefusalCode,
  path: string,
  detail: string,
): SupportRefusal => ({
  code,
  path,
  detail,
});

/** The thrower for a refusal a door answers before any service runs. */
export const refuse = refuser<SupportRefusalCode>('SUPPORT_REFUSED');
