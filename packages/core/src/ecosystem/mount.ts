import { Hono } from 'hono';
import { ecosystemProjectRoutes } from './project-routes.js';
import { ecosystemRoutes, membershipRoutes } from './routes.js';

export const ecosystemApiRoutes = new Hono();

ecosystemApiRoutes.route('/projects', ecosystemProjectRoutes);
ecosystemApiRoutes.route('/ecosystems', ecosystemRoutes);
ecosystemApiRoutes.route('/memberships', membershipRoutes);
