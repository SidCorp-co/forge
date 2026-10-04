import { Hono } from 'hono';
import { channelProjectRoutes } from './channel-routes.js';
import { contractRoutes } from './contract/routes.js';
import { busRoutes, linkProjectRoutes } from './link-routes.js';
import { ecosystemProjectRoutes } from './project-routes.js';
import { contractRequestRoutes } from './requests/routes.js';
import { ecosystemRoutes, membershipRoutes } from './routes.js';
import { contractStandingRoutes } from './standing/routes.js';

export const ecosystemApiRoutes = new Hono();

ecosystemApiRoutes.route('/projects', ecosystemProjectRoutes);
ecosystemApiRoutes.route('/projects', channelProjectRoutes);
ecosystemApiRoutes.route('/projects', contractRoutes);
ecosystemApiRoutes.route('/projects', linkProjectRoutes);
ecosystemApiRoutes.route('/projects', contractRequestRoutes);
ecosystemApiRoutes.route('/projects', contractStandingRoutes);
ecosystemApiRoutes.route('/ecosystems', ecosystemRoutes);
ecosystemApiRoutes.route('/ecosystems', busRoutes);
ecosystemApiRoutes.route('/memberships', membershipRoutes);
