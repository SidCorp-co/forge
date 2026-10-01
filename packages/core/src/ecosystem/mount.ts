import { Hono } from 'hono';
import { channelProjectRoutes } from './channel-routes.js';
import { ecosystemProjectRoutes } from './project-routes.js';
import { ecosystemRoutes, membershipRoutes } from './routes.js';

export const ecosystemApiRoutes = new Hono();

ecosystemApiRoutes.route('/projects', ecosystemProjectRoutes);
ecosystemApiRoutes.route('/projects', channelProjectRoutes);
ecosystemApiRoutes.route('/ecosystems', ecosystemRoutes);
ecosystemApiRoutes.route('/memberships', membershipRoutes);
