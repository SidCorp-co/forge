import { BUILTIN_WORKFLOW_TEMPLATES, findTemplate } from '@forge/contracts/workflow-templates';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { templateNotFound, templateSummary, templateView } from './template-service.js';

/**
 * The kernel's built-in diagram templates, public like the schemas: they are the vocabulary a
 * design is checked against and carry no project's data. A project's own templates are read at
 * `/api/projects/:id/workflow-templates`, behind its access.
 */
export const workflowTemplateCatalogueRoutes = new Hono();

const catalogueQuery = zValidator(
  'query',
  z.strictObject({ projectId: z.string().optional() }),
  invalid('invalid query: the catalogue takes no parameters (a projectId is refused by name)'),
);

workflowTemplateCatalogueRoutes.get('/', catalogueQuery, (c) => {
  const { projectId } = c.req.valid('query');
  if (projectId !== undefined) {
    throw new HTTPException(400, {
      message: `WORKFLOW_TEMPLATES_PROJECT_ROUTE: this catalogue is public and holds the built-ins only; a project's templates, merged with these, are read behind its access at GET /api/projects/${projectId}/workflow-templates.`,
      cause: { code: 'WORKFLOW_TEMPLATES_PROJECT_ROUTE' },
    });
  }
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    templates: BUILTIN_WORKFLOW_TEMPLATES.map((t) => templateSummary(t, 'builtin')),
    returned: BUILTIN_WORKFLOW_TEMPLATES.length,
  });
});

workflowTemplateCatalogueRoutes.get('/:templateId/:version', (c) => {
  const { templateId, version } = c.req.param();
  const found = /^[1-9][0-9]*$/.test(version)
    ? findTemplate(BUILTIN_WORKFLOW_TEMPLATES, { id: templateId, version: Number(version) })
    : null;
  if (!found) throw templateNotFound(templateId, version, BUILTIN_WORKFLOW_TEMPLATES);
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(templateView(found, 'builtin'));
});
