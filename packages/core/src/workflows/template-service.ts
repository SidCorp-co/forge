import { findTemplate, type WorkflowTemplate } from '@forge/contracts/workflow-templates';
import { HTTPException } from 'hono/http-exception';
import { assertProjectAccess } from '../lib/authz.js';
import { templatesOf } from './service.js';
import { TEMPLATE_EXAMPLES } from './template-examples.js';

/** One template as served: the template, the built-in example drawn in it (if any), and whose it is. */
export function templateView(template: WorkflowTemplate, origin: 'builtin' | 'project') {
  return {
    origin,
    template,
    example: TEMPLATE_EXAMPLES[`${template.id}@${template.version}`] ?? null,
  };
}

/** The list form: every template without its example, which only the single read carries. */
export const templateSummary = (template: WorkflowTemplate, origin: 'builtin' | 'project') => ({
  origin,
  template,
});

export function templateNotFound(id: string, version: string, known: readonly WorkflowTemplate[]) {
  return new HTTPException(404, {
    message: `WORKFLOW_TEMPLATE_UNKNOWN: no template ${id}@${version}; known: ${known.map((t) => `${t.id}@${t.version}`).join(', ')}`,
    cause: { code: 'WORKFLOW_TEMPLATE_UNKNOWN' },
  });
}

/** The templates a project may draw in — the built-ins, then its own — read with its access. */
export async function listProjectTemplatesAs(userId: string, projectId: string) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const { templates, projectKeys } = await templatesOf(projectId);
  return templates.map((t) =>
    templateSummary(t, projectKeys.has(`${t.id}@${t.version}`) ? 'project' : 'builtin'),
  );
}

export async function readProjectTemplateAs(
  userId: string,
  projectId: string,
  templateId: string,
  version: string,
) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const { templates, projectKeys } = await templatesOf(projectId);
  const found = /^[1-9][0-9]*$/.test(version)
    ? findTemplate(templates, { id: templateId, version: Number(version) })
    : null;
  if (!found) throw templateNotFound(templateId, version, templates);
  return templateView(
    found,
    projectKeys.has(`${found.id}@${found.version}`) ? 'project' : 'builtin',
  );
}
