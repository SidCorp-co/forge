import type { Hono } from 'hono';
import { needsYouRoutes } from '../development/needs-you-routes.js';
import { developmentOverviewRoutes } from '../development/overview-routes.js';
import { contractWaitRoutes } from '../ecosystem/waits/routes.js';
import type { RequestIdVars } from '../middleware/request-id.js';
import { issueActivityRoutes } from './activity-routes.js';
import { issueCriteriaRoutes } from './criteria/routes.js';
import { issueDependencyRoutes } from './dependency-routes.js';
import { issueProjectRoutes, issueRoutes } from './routes.js';
import { searchRoutes } from './search.js';
import { issueStandingRoutes } from './standing-routes.js';
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
  app.route('/api/issues', contractWaitRoutes);
}

/** The project-scoped issue reads under `/api/projects/:id/issues…`: the list, search, and the
 *  standing read model the Issues screen draws, in the order they are matched, then the Development
 *  overview built over it, and the waiting-on-you counts read from each list's own model. */
export function mountIssueProjectRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/projects', issueProjectRoutes);
  app.route('/api/projects', searchRoutes);
  app.route('/api/projects', issueStandingRoutes);
  app.route('/api/projects', developmentOverviewRoutes);
  app.route('/api/projects', needsYouRoutes);
}
