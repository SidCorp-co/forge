import type { Hono } from 'hono';
import type { RequestIdVars } from '../middleware/request-id.js';
import { projectConfigRoutes } from './routes.js';
import { projectConfigSchemaRoutes } from './schema-routes.js';

export function mountProjectConfig(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api', projectConfigSchemaRoutes);
  app.route('/api/projects', projectConfigRoutes);
}
