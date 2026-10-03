import type { Hono } from 'hono';
import type { RequestIdVars } from '../middleware/request-id.js';
import { issueActivityRoutes } from './activity-routes.js';
import { issueCriteriaRoutes } from './criteria/routes.js';
import { issueDependencyRoutes } from './dependency-routes.js';
import { issueRoutes } from './routes.js';
import { issueSteerRoutes } from './steer-routes.js';
import { transitionRoutes } from './transition.js';

/** The per-issue routes under `/api/issues/:id`, in the order they are matched. */
export function mountIssueRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/issues', issueRoutes);
  app.route('/api/issues', transitionRoutes);
  app.route('/api/issues', issueActivityRoutes);
  app.route('/api/issues', issueDependencyRoutes);
  app.route('/api/issues', issueSteerRoutes);
  app.route('/api/issues', issueCriteriaRoutes);
}
