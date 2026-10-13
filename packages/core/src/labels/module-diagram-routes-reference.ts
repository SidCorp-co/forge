import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { moduleDiagramKinds } from './module-diagrams.js';

export const moduleDiagramSchema = z.object({
  kind: z.enum(moduleDiagramKinds),
  mermaid: z.string(),
  moduleCount: z.number(),
  generatedAt: z.string(),
});

export const readModuleDiagram = describeOperation({
  summary: "Draw one of a project's module diagrams as Mermaid, from the rows as they are now",
  description: 'Never cached, so a diagram cannot be older than the knowledge it draws.',
  responses: {
    200: json(moduleDiagramSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project does not exist'),
    409: fail({
      NO_MODULES: 'the project has no modules',
      NO_MODULE_FLOWS: 'no module stores a Mermaid flow in its knowledge node',
      UNPARSABLE_MODULE_FLOW: 'a module stores a flow the generator cannot read',
    }),
  },
});
