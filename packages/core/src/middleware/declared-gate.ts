export const AUTH_GATES = {
  requireAuth: 'a session JWT, or a personal or agent access token held to its grant',
  requireUserOrDevice:
    'a session JWT, a paired device credential, or a personal or agent access token held to its grant',
  requireUser: 'a session JWT, in the Authorization header or the session cookie',
  requirePat: 'a personal or agent access token only',
  requireDevice: 'a paired device credential only',
  assertEmailVerified: 'a person whose email address is verified (a device passes)',
  requireAdmin: 'a platform administrator',
  requireFreshAuth: 'a caller who re-authenticated within the window the route sets',
} as const;

export type AuthGate = keyof typeof AUTH_GATES;

const gates = new WeakMap<object, AuthGate>();

export const declaredGates: Pick<WeakMap<object, AuthGate>, 'get'> = gates;

// the API contract reads which credential a route admits off the gate itself
export function declareGate<M extends object>(name: AuthGate, middleware: M): M {
  gates.set(middleware, name);
  return middleware;
}
