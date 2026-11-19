// The support doors, mounted where the route registry places them: the project routes; the owner's
// browser, back from the product's sign-in with no Forge session (ISS-1047); and a secret's one-time
// write URL, whose token is its credential (ISS-1348).

import type { Hono } from 'hono';
import type { RequestIdVars } from '../middleware/request-id.js';
import { ownerSignInCallbackRoutes } from './owner-routes.js';
import { supportRoutes } from './routes.js';
import { secretWriteRoutes } from './secret-write.js';

export function mountSupportDoors(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/projects', supportRoutes);
  app.route('/api/support', ownerSignInCallbackRoutes);
  app.route('/api/secret-writes', secretWriteRoutes);
}
