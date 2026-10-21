import { UNKNOWN_QUERY_PARAMETER } from '../../lib/query-strict.js';
import { fieldsPolicy } from '../../lib/unknown-fields.js';
import { QUERY_NOT_TAKEN_WHEN, queryGateCovers, takesNoQuery } from '../declare/input-not-taken.js';
import { BODY_NOT_TAKEN_WHEN } from '../declare/validator.js';
import type { RouteEntry } from './registry.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const STRAY_QUERY_KEY_WHEN =
  'a query parameter this route does not take; details lists the ones it does';

/** A write route `refuseBodyNotTaken` holds to no body: it declares none and names no reason. */
function takesNoBody(entry: RouteEntry): boolean {
  if (!WRITE_METHODS.has(entry.method) || entry.bodyAsSent !== null) return false;
  return !entry.validators.some((v) => v.target === 'json' || v.target === 'form');
}

/** The 400s a route meets for a body or a query key it does not take, ahead of its schemas. */
export function inputGateCodes(
  entry: RouteEntry,
): { status: number; code: string; when: string }[] {
  const codes: { status: number; code: string; when: string }[] = [];
  if (takesNoBody(entry))
    codes.push({ status: 400, code: 'BAD_REQUEST', when: BODY_NOT_TAKEN_WHEN });
  if (queryGateCovers(entry.path) && takesNoQuery(entry.method, entry.validators))
    codes.push({ status: 400, code: UNKNOWN_QUERY_PARAMETER, when: QUERY_NOT_TAKEN_WHEN });
  for (const declaration of entry.validators) {
    if (declaration.target === 'query' && fieldsPolicy(declaration.schema) !== 'open')
      codes.push({ status: 400, code: UNKNOWN_QUERY_PARAMETER, when: STRAY_QUERY_KEY_WHEN });
  }
  return codes;
}
