import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { domainTemplates } from '../db/schema.js';

export const domainTemplateSchema = tableRow(domainTemplates);

export const appliedTemplateSchema = z.object({
  templateKey: z.string(),
  agentId: z.string(),
  appConfigId: z.string(),
  registeredSkillNames: z.array(z.string()),
  skippedSkillNames: z.array(z.string()),
});

export const listDomainTemplates = describeOperation({
  summary: 'Every domain template, by key',
  responses: { 200: json(z.array(domainTemplateSchema)) },
});

export const readDomainTemplate = describeOperation({
  summary: 'Read one domain template by key',
  responses: {
    200: json(domainTemplateSchema),
    404: fail('NOT_FOUND', 'there is no such template'),
  },
});

export const applyDomainTemplate = describeOperation({
  summary: 'Apply a domain template to a project: its agent, its settings and its skills',
  description: 'Project admins only.',
  responses: {
    200: json(appliedTemplateSchema, 'What the template created and which skills it registered'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'there is no such project or no such template'),
    500: fail('TEMPLATE_INVALID', 'the stored manifest no longer parses'),
  },
});
