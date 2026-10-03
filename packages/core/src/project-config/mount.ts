import type { Hono } from 'hono';
import { baDoorRoutes } from '../assistant/ba-door-routes.js';
import { contentLanguageRoutes } from '../content-language/routes.js';
import { feedbackRoutes } from '../feedback/routes.js';
import type { RequestIdVars } from '../middleware/request-id.js';
import { onboardingRoutes } from '../onboarding/routes.js';
import { questionnaireRoutes } from '../questionnaires/routes.js';
import { requirementRoutes } from '../requirements/routes.js';
import { suggestionRoutes } from '../suggestions/routes.js';
import { workflowRoutes } from '../workflows/routes.js';
import { workflowTemplateCatalogueRoutes } from '../workflows/template-routes.js';
import { environmentStateRoutes } from './environment-state-routes.js';
import { projectConfigRoutes } from './routes.js';
import { projectConfigSchemaRoutes } from './schema-routes.js';

export function mountProjectConfig(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api', projectConfigSchemaRoutes);
  app.route('/api/workflow-templates', workflowTemplateCatalogueRoutes);
  app.route('/api/projects', projectConfigRoutes);
  app.route('/api/projects', environmentStateRoutes);
  app.route('/api/projects', workflowRoutes);
  app.route('/api/projects', requirementRoutes);
  app.route('/api/projects', suggestionRoutes);
  app.route('/api/projects', feedbackRoutes);
  app.route('/api/projects', baDoorRoutes);
  app.route('/api/projects', onboardingRoutes);
  app.route('/api/projects', questionnaireRoutes);
  app.route('/api/projects', contentLanguageRoutes);
}
