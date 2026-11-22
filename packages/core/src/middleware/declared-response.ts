// A success answer a handler declares for the API contract (ISS-1412): the generator
// (`api-contract/openapi.ts`) reads it off the handler, as it reads a validator's schema, and writes it
// under the operation's status. A route answers one body to every caller, but a door ahead of it may
// answer its own credential with another, so a declaration names the credential it is answered under,
// and the contract keeps every other caller's answer undeclared beside it.

import type { z } from 'zod';

export interface DeclaredResponse {
  /** The one method the answer is given to; a door registered for every method declares which. */
  method: string;
  status: number;
  /** Who is answered this body, as a caller reads it: `a feedback server key (Bearer fsk_…)`. */
  under: string;
  description: string;
  schema: z.ZodType;
}

const declared = new WeakMap<object, DeclaredResponse>();

export const declaredResponses: Pick<WeakMap<object, DeclaredResponse>, 'get'> = declared;

/** `handler`, its answer declared for the contract; the handler itself runs unchanged. */
export function declareResponse<H extends object>(handler: H, response: DeclaredResponse): H {
  declared.set(handler, response);
  return handler;
}
